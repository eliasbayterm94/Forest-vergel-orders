'use strict';

// Endpoints de costeo: proveedores, tarifas versionadas, recepciones
// con flotes, pools y el consumo de materia por el lote.
//
// Lo que estos tests protegen sobre todo: que nada se cuele a costo
// cero por accidente, y que un pool sin saldo NO bloquee la operación.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const { loadHandler, setFake, postEvent, parseRes } = require('./helpers/fn-harness');

const LOT = 'cccccccc-0000-0000-0000-000000000001';
const SUP_OWN = 'sup-own-0000';
const SUP_MZ  = 'sup-mz-0000';

function fixture(extra = {}) {
  return createFakeSupabase({
    suppliers: [
      { id: SUP_OWN, name: 'El Vergel',  kind: 'own',         region: null, active: true },
      { id: SUP_MZ,  name: 'Manzanares', kind: 'third_party', region: 'Caldas', active: true },
      { id: 'sup-off', name: 'Viejo',    kind: 'third_party', region: null, active: false },
    ],
    production_lots: [{
      id: LOT, bache_code: '26-300', lot_code: 'LOT-300', status: 'InFermentation',
      lot_kind: 'main', processing_stage: 'cereza', kg_input_initial: 1000,
      start_date: '2026-10-19',
    }],
    cherry_receptions: [],
    lot_byproducts: [],
    lot_input_sources: [],
    costing_parameters: [],
    ...extra,
  });
}

const supList    = loadHandler('suppliers-list', fixture());
const supCreate  = loadHandler('suppliers-create');
const supUpdate  = loadHandler('suppliers-update');
const parList    = loadHandler('costing-parameters-list');
const parCreate  = loadHandler('costing-parameters-create');
const recCreate  = loadHandler('cherry-receptions-create');
const recList    = loadHandler('cherry-receptions-list');
const bpCreate   = loadHandler('lot-byproducts-create');
const poolList   = loadHandler('cost-pools-list');
const srcCreate  = loadHandler('lot-input-sources-create');
const srcList    = loadHandler('lot-input-sources-list');

const asAdmin = (b) => postEvent(b, { role: 'admin' });
const asFinca = (b) => postEvent(b, { role: 'finca' });
const getAs = (role, query = {}) => ({
  httpMethod: 'GET', headers: postEvent(null, { role }).headers, queryStringParameters: query,
});

// ══════════════════════════════════════════════════════════════
// PROVEEDORES
// ══════════════════════════════════════════════════════════════

test('proveedores: lista solo activos por defecto', async () => {
  setFake(fixture());
  const r = parseRes(await supList(getAs('finca')));
  assert.equal(r.status, 200);
  assert.equal(r.body.suppliers.length, 2);
});

test('proveedores: include_inactive trae los desactivados', async () => {
  setFake(fixture());
  const r = parseRes(await supList(getAs('finca', { include_inactive: 'true' })));
  assert.equal(r.body.suppliers.length, 3);
});

test('proveedores: crear exige kind válido', async () => {
  setFake(fixture());
  assert.equal(parseRes(await supCreate(asAdmin({ name: 'X', kind: 'amigo' }))).body.code, 'KIND_INVALID');
  assert.equal(parseRes(await supCreate(asAdmin({ kind: 'own' }))).body.code, 'NAME_REQUIRED');
});

test('proveedores: crear es idempotente y reactiva', async () => {
  const fake = fixture();
  setFake(fake);
  const dup = parseRes(await supCreate(asAdmin({ name: 'Manzanares', kind: 'third_party' })));
  assert.equal(dup.status, 200);
  assert.equal(dup.body.created, false);

  const back = parseRes(await supCreate(asAdmin({ name: 'Viejo', kind: 'third_party' })));
  assert.equal(back.body.supplier.active, true);
});

test('proveedores: el TIPO no se puede cambiar', async () => {
  // Cambiar own <-> third_party reescribiría el costeo de todo el
  // pasado, y los snapshots estan congelados.
  setFake(fixture());
  const r = parseRes(await supUpdate(asAdmin({ id: SUP_MZ, fields: { kind: 'own' } })));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'SUPPLIER_KIND_IMMUTABLE');
});

test('proveedores: un rol no-admin no puede crear', async () => {
  setFake(fixture());
  assert.equal(parseRes(await supCreate(asFinca({ name: 'Y', kind: 'own' }))).status, 403);
});

// ══════════════════════════════════════════════════════════════
// TARIFAS VERSIONADAS
// ══════════════════════════════════════════════════════════════

test('tarifas: crear valida fecha y montos', async () => {
  setFake(fixture());
  assert.equal(parseRes(await parCreate(asAdmin({ effective_from: '19-10-2026', t1_per_kg_net: 630, t2_per_kg_own_net: 6000 }))).body.code, 'INVALID_DATE');
  assert.equal(parseRes(await parCreate(asAdmin({ effective_from: '2026-01-01', t2_per_kg_own_net: 6000 }))).body.code, 'INVALID_T1');
  assert.equal(parseRes(await parCreate(asAdmin({ effective_from: '2026-01-01', t1_per_kg_net: -5, t2_per_kg_own_net: 6000 }))).body.code, 'INVALID_T1');
});

test('tarifas: se crean y se identifica la vigente', async () => {
  const fake = fixture();
  setFake(fake);
  assert.equal(parseRes(await parCreate(asAdmin({
    effective_from: '2026-01-01', t1_per_kg_net: 630, t2_per_kg_own_net: 6000,
    annual_mandate_cop: 140000000, budget_kg_net: 1000000,
  }))).status, 201);
  assert.equal(parseRes(await parCreate(asAdmin({
    effective_from: '2026-04-01', t1_per_kg_net: 680, t2_per_kg_own_net: 6200,
  }))).status, 201);

  const r = parseRes(await parList(getAs('admin')));
  assert.equal(r.body.costing_parameters.length, 2);
  // La vigente depende de hoy; ambas son pasadas, gana la mas reciente.
  assert.equal(Number(r.body.in_force.t1_per_kg_net), 680);
});

test('tarifas: la finca no las ve (son de admin/forest)', async () => {
  setFake(fixture());
  assert.equal(parseRes(await parList(getAs('finca'))).status, 403);
});

// ══════════════════════════════════════════════════════════════
// RECEPCIONES
// ══════════════════════════════════════════════════════════════

test('recepción: café propio NO lleva precio', async () => {
  const fake = fixture();
  setFake(fake);
  const r = parseRes(await recCreate(asFinca({
    supplier_id: SUP_OWN, received_date: '2026-10-19', entry_stage: 'cereza', kg_gross: 2000,
  })));
  assert.equal(r.status, 201);
  assert.equal(r.body.reception.price_per_kg, null);
  assert.equal(r.body.reception.kg_net, 2000);
});

test('recepción: valida lo esencial antes de guardar', async () => {
  setFake(fixture());
  const r = parseRes(await recCreate(asFinca({
    supplier_id: SUP_MZ, received_date: 'ayer', entry_stage: 'humedo', kg_gross: -5,
  })));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /received_date/);
  assert.match(r.body.error, /entry_stage/);
  assert.match(r.body.error, /kg_gross/);
});

test('recepción: descuento fuera de 0..1 se rechaza', async () => {
  setFake(fixture());
  const r = parseRes(await recCreate(asFinca({
    supplier_id: SUP_MZ, received_date: '2026-10-19', entry_stage: 'cereza',
    kg_gross: 1000, price_per_kg: 3000, discount_pct: 1.5,
  })));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /discount_pct/);
});

test('recepción con flotes en una sola llamada: neto y regla de oro', async () => {
  const fake = fixture();
  setFake(fake);
  const r = parseRes(await recCreate(asFinca({
    supplier_id: SUP_MZ, received_date: '2026-10-19', entry_stage: 'cereza',
    kg_gross: 1000, price_per_kg: 3000, discount_pct: 0.05, pool_key: 'regional',
    byproduct: { kg: 80, measurement: 'estimated' },
  })));
  assert.equal(r.status, 201);
  assert.equal(r.body.reception.kg_net, 920);
  const s = r.body.reception.byproduct_summary;
  assert.equal(s.byproduct_pct, 0.08);
  assert.equal(s.discount_pct, 0.05);
  assert.equal(s.shortfall_pct, 0.03);      // faltaron 3 puntos de descuento
  assert.equal(s.has_estimates, true);
  assert.equal(fake._db.lot_byproducts.length, 1);
});

test('recepción: flotes >= bruto se rechaza (no quedaría café usable)', async () => {
  setFake(fixture());
  const r = parseRes(await recCreate(asFinca({
    supplier_id: SUP_MZ, received_date: '2026-10-19', entry_stage: 'cereza',
    kg_gross: 1000, price_per_kg: 3000,
    byproduct: { kg: 1000, measurement: 'weighed' },
  })));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /kg_gross/);
});

test('recepciones: el listado trae neto y resumen de flotes', async () => {
  const fake = fixture();
  setFake(fake);
  await recCreate(asFinca({
    supplier_id: SUP_MZ, received_date: '2026-10-19', entry_stage: 'cereza',
    kg_gross: 1000, price_per_kg: 3000, pool_key: 'regional',
    byproduct: { kg: 50, measurement: 'weighed' },
  }));
  const r = parseRes(await recList(getAs('admin')));
  assert.equal(r.status, 200);
  assert.equal(r.body.receptions[0].kg_net, 950);
  assert.equal(r.body.receptions[0].byproducts.length, 1);
});

// ══════════════════════════════════════════════════════════════
// SUBPRODUCTO APARTE
// ══════════════════════════════════════════════════════════════

test('subproducto: exige exactamente un origen', async () => {
  setFake(fixture());
  assert.equal(parseRes(await bpCreate(asFinca({
    kg: 10, measurement: 'weighed', measured_stage: 'cereza',
  }))).body.code, 'SOURCE_REQUIRED');
  assert.equal(parseRes(await bpCreate(asFinca({
    source_reception_id: 'a', source_lot_id: 'b', kg: 10,
    measurement: 'weighed', measured_stage: 'cereza',
  }))).body.code, 'SOURCE_AMBIGUOUS');
});

test('subproducto desde un bache propio (sin recepción de compra)', async () => {
  const fake = fixture();
  setFake(fake);
  const r = parseRes(await bpCreate(asFinca({
    source_lot_id: LOT, kg: 40, measurement: 'estimated',
    measured_stage: 'despulpado', separated_on: '2026-10-20',
  })));
  assert.equal(r.status, 201);
  assert.equal(r.body.byproduct.measurement, 'estimated');
});

test('subproducto: no se puede separar más de lo que entró', async () => {
  const fake = fixture();
  setFake(fake);
  const rec = parseRes(await recCreate(asFinca({
    supplier_id: SUP_MZ, received_date: '2026-10-19', entry_stage: 'cereza',
    kg_gross: 1000, price_per_kg: 3000,
    byproduct: { kg: 900, measurement: 'weighed' },
  })));
  const r = parseRes(await bpCreate(asFinca({
    source_reception_id: rec.body.reception.id, kg: 150,
    measurement: 'weighed', measured_stage: 'cereza',
  })));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'EXCEEDS_GROSS');
});

// ══════════════════════════════════════════════════════════════
// POOL
// ══════════════════════════════════════════════════════════════

test('pool: el promedio ponderado del caso real', async () => {
  const fake = fixture();
  setFake(fake);
  await recCreate(asFinca({ supplier_id: SUP_MZ, received_date: '2026-10-19',
    entry_stage: 'cereza', kg_gross: 5000, price_per_kg: 3000, pool_key: 'regional' }));
  await recCreate(asFinca({ supplier_id: SUP_MZ, received_date: '2026-10-19',
    entry_stage: 'cereza', kg_gross: 3500, price_per_kg: 3800, pool_key: 'regional' }));

  const r = parseRes(await poolList(getAs('finca', { pool_key: 'regional' })));
  assert.equal(r.status, 200);
  const p = r.body.pools[0];
  assert.equal(p.kg_on_hand, 8500);
  assert.equal(p.cop_on_hand, 28300000);
  assert.equal(p.avg_cost_per_kg, 3329.4118);
  assert.equal(p.is_short, false);
});

// ══════════════════════════════════════════════════════════════
// CONSUMO DE MATERIA POR EL LOTE
// ══════════════════════════════════════════════════════════════

test('consumo del pool: congela el promedio del momento', async () => {
  const fake = fixture();
  setFake(fake);
  await recCreate(asFinca({ supplier_id: SUP_MZ, received_date: '2026-10-19',
    entry_stage: 'cereza', kg_gross: 5000, price_per_kg: 3000, pool_key: 'regional' }));
  await recCreate(asFinca({ supplier_id: SUP_MZ, received_date: '2026-10-19',
    entry_stage: 'cereza', kg_gross: 3500, price_per_kg: 3800, pool_key: 'regional' }));

  const r = parseRes(await srcCreate(asFinca({
    production_lot_id: LOT, cost_basis: 'purchase_pool', pool_key: 'regional',
    kg: 1000, entry_stage: 'cereza',
  })));
  assert.equal(r.status, 201);
  assert.equal(Number(r.body.input_source.purchase_cost_per_kg), 3329.4118);
  assert.equal(r.body.warning, null);
});

test('consumo del pool SIN saldo: pasa con alerta, no bloquea', async () => {
  // La decisión de operación: no trancar un bache por una factura
  // que el administrativo no alcanzó a cargar.
  const fake = fixture();
  setFake(fake);
  await recCreate(asFinca({ supplier_id: SUP_MZ, received_date: '2026-10-19',
    entry_stage: 'cereza', kg_gross: 500, price_per_kg: 3000, pool_key: 'regional' }));

  const r = parseRes(await srcCreate(asFinca({
    production_lot_id: LOT, cost_basis: 'purchase_pool', pool_key: 'regional',
    kg: 900, entry_stage: 'cereza',
  })));
  assert.equal(r.status, 201);                                  // NO bloquea
  assert.ok(r.body.warning);                                    // pero avisa
  assert.match(r.body.warning, /negativo/);
  assert.equal(Number(r.body.input_source.purchase_cost_per_kg), 3000);  // no cero
});

test('consumo de un pool inexistente sí se rechaza (no hay precio que usar)', async () => {
  setFake(fixture());
  const r = parseRes(await srcCreate(asFinca({
    production_lot_id: LOT, cost_basis: 'purchase_pool', pool_key: 'fantasma',
    kg: 100, entry_stage: 'cereza',
  })));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'POOL_EMPTY');
});

test('consumo identificado: precio por kg NETO, no por kg bruto', async () => {
  const fake = fixture();
  setFake(fake);
  const rec = parseRes(await recCreate(asFinca({
    supplier_id: SUP_MZ, received_date: '2026-10-19', entry_stage: 'cereza',
    kg_gross: 1000, price_per_kg: 3000, discount_pct: 0.05,
    byproduct: { kg: 80, measurement: 'weighed' },
  })));
  const r = parseRes(await srcCreate(asFinca({
    production_lot_id: LOT, cost_basis: 'purchase_identified',
    reception_id: rec.body.reception.id, kg: 920, entry_stage: 'cereza',
  })));
  assert.equal(r.status, 201);
  // 2.850.000 pagado / 920 neto = 3.097,8261
  assert.equal(Number(r.body.input_source.purchase_cost_per_kg), 3097.8261);
});

test('consumo identificado de una recepción propia se rechaza (va por own)', async () => {
  const fake = fixture();
  setFake(fake);
  const rec = parseRes(await recCreate(asFinca({
    supplier_id: SUP_OWN, received_date: '2026-10-19', entry_stage: 'cereza', kg_gross: 1000,
  })));
  const r = parseRes(await srcCreate(asFinca({
    production_lot_id: LOT, cost_basis: 'purchase_identified',
    reception_id: rec.body.reception.id, kg: 500, entry_stage: 'cereza',
  })));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'RECEPTION_HAS_NO_PRICE');
});

test('consumo propio y de subproducto no llevan precio', async () => {
  const fake = fixture();
  setFake(fake);
  const own = parseRes(await srcCreate(asFinca({
    production_lot_id: LOT, cost_basis: 'own', kg: 600, entry_stage: 'cereza',
  })));
  assert.equal(own.status, 201);
  assert.equal(own.body.input_source.purchase_cost_per_kg, null);

  const bp = parseRes(await srcCreate(asFinca({
    production_lot_id: LOT, cost_basis: 'byproduct', kg: 40, entry_stage: 'despulpado',
  })));
  assert.equal(bp.status, 201);
  assert.equal(bp.body.input_source.purchase_cost_per_kg, null);
});

test('consumo: bache inexistente y cost_basis inválido se rechazan', async () => {
  setFake(fixture());
  assert.equal(parseRes(await srcCreate(asFinca({
    production_lot_id: 'no-existe', cost_basis: 'own', kg: 100, entry_stage: 'cereza',
  }))).status, 404);
  assert.equal(parseRes(await srcCreate(asFinca({
    production_lot_id: LOT, cost_basis: 'regalado', kg: 100, entry_stage: 'cereza',
  }))).body.code, 'INVALID_BASIS');
});

test('red de seguridad: lotes sin fuente de materia se pueden listar', async () => {
  const fake = fixture();
  setFake(fake);
  let r = parseRes(await srcList(getAs('admin', { missing: 'true' })));
  assert.equal(r.body.lots_without_source.length, 1);          // el bache 26-300

  await srcCreate(asFinca({ production_lot_id: LOT, cost_basis: 'own', kg: 1000, entry_stage: 'cereza' }));
  r = parseRes(await srcList(getAs('admin', { missing: 'true' })));
  assert.equal(r.body.lots_without_source.length, 0);
});
