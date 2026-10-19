'use strict';

// Cierre mensual y reporte de costo por lote.
//
// Lo que estos tests protegen:
//   · el absorbido sale de los snapshots congelados, así que revisar
//     una tarifa NO mueve un mes ya cerrado;
//   · los snapshots anulados no cuentan;
//   · las mezclas no aportan T1 (su cereza ya lo pagó);
//   · guardar el cierre recalcula los totales en el servidor, nunca
//     confía en lo que manda la pantalla.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const { loadHandler, setFake, postEvent, parseRes } = require('./helpers/fn-harness');

const snap = (over = {}) => ({
  id: `s-${Math.random().toString(36).slice(2, 8)}`,
  production_lot_id: 'lot-1',
  costing_parameters_id: 'p1',
  t1_per_kg_net: 630, t2_per_kg_own_net: 6000,
  snapshot_date: '2026-10-15',
  kg_input_net_total: 1000, kg_input_net_own: 0, kg_input_net_purchased: 1000,
  kg_dried_output: 200,
  real_factor_dried_per_input: 0.2,
  purchase_cost_cop: 3800000, t2_cost_cop: 0, t1_cost_cop: 630000,
  total_cost_cop: 4430000, cost_per_kg_dried: 22150,
  source_kind: 'computed', voided_at: null,
  ...over,
});

function fixture({ snapshots = [], closures = [], lots = [] } = {}) {
  return createFakeSupabase({
    lot_cost_snapshots: snapshots,
    monthly_cost_closures: closures,
    production_lots: lots.length ? lots : [
      { id: 'lot-1', bache_code: '26-500', process_type: 'Lavado', processing_stage: 'cereza',
        lot_kind: 'main', is_blend: false, ready_date: '2026-10-15', factor_rendimiento: 92.1 },
    ],
  });
}

const computeH = loadHandler('monthly-closure-compute', fixture());
const saveH    = loadHandler('monthly-closure-save');
const listH    = loadHandler('monthly-closures-list');
const reportH  = loadHandler('lot-costs-report');

const getAs = (role, query = {}) => ({
  httpMethod: 'GET', headers: postEvent(null, { role }).headers, queryStringParameters: query,
});
const asAdmin = (b) => postEvent(b, { role: 'admin' });

// ══════════════════════════════════════════════════════════════
// CÁLCULO DEL MES
// ══════════════════════════════════════════════════════════════

test('absorbido = suma de T1 y T2 de los snapshots del mes', async () => {
  setFake(fixture({ snapshots: [
    snap({ t1_cost_cop: 630000, t2_cost_cop: 0 }),
    snap({ t1_cost_cop: 630000, t2_cost_cop: 6000000, kg_input_net_own: 1000, kg_input_net_purchased: 0 }),
  ] }));
  const r = parseRes(await computeH(getAs('admin', { year: '2026', month: '10' })));
  assert.equal(r.status, 200);
  assert.equal(r.body.computed.absorbed_t1_cop, 1_260_000);
  assert.equal(r.body.computed.absorbed_t2_cop, 6_000_000);
  assert.equal(r.body.computed.absorbed_total_cop, 7_260_000);
  assert.equal(r.body.computed.snapshot_count, 2);
});

test('la compra de cereza NO es absorción: se reporta aparte', async () => {
  // El mandato cubre el costo de planta, no el precio del café.
  setFake(fixture({ snapshots: [snap()] }));
  const r = parseRes(await computeH(getAs('admin', { year: '2026', month: '10' })));
  assert.equal(r.body.computed.purchase_cost_cop, 3_800_000);
  assert.equal(r.body.computed.absorbed_total_cop, 630_000);
  assert.equal(r.body.computed.total_lot_cost_cop, 4_430_000);
});

test('los snapshots ANULADOS no cuentan en el mes', async () => {
  setFake(fixture({ snapshots: [
    snap({ t1_cost_cop: 630000 }),
    snap({ t1_cost_cop: 999999, voided_at: '2026-10-20T00:00:00Z' }),
  ] }));
  const r = parseRes(await computeH(getAs('admin', { year: '2026', month: '10' })));
  assert.equal(r.body.computed.absorbed_t1_cop, 630_000);
  assert.equal(r.body.computed.snapshot_count, 1);
});

test('solo entran los snapshots del mes pedido', async () => {
  setFake(fixture({ snapshots: [
    snap({ snapshot_date: '2026-09-30', t1_cost_cop: 111 }),
    snap({ snapshot_date: '2026-10-01', t1_cost_cop: 222 }),
    snap({ snapshot_date: '2026-10-31', t1_cost_cop: 333 }),
    snap({ snapshot_date: '2026-11-01', t1_cost_cop: 444 }),
  ] }));
  const r = parseRes(await computeH(getAs('admin', { year: '2026', month: '10' })));
  assert.equal(r.body.computed.absorbed_t1_cop, 555);   // 222 + 333
  assert.equal(r.body.computed.snapshot_count, 2);
});

test('diciembre cruza bien el año', async () => {
  setFake(fixture({ snapshots: [
    snap({ snapshot_date: '2026-12-31', t1_cost_cop: 100 }),
    snap({ snapshot_date: '2027-01-01', t1_cost_cop: 999 }),
  ] }));
  const r = parseRes(await computeH(getAs('admin', { year: '2026', month: '12' })));
  assert.equal(r.body.computed.absorbed_t1_cop, 100);
});

test('las mezclas no aportan T1 (su cereza ya lo pagó)', async () => {
  setFake(fixture({ snapshots: [
    snap({ t1_cost_cop: 630000 }),
    snap({ source_kind: 'inherited_blend', t1_cost_cop: 0, t2_cost_cop: 0,
      purchase_cost_cop: 12160000 }),
  ] }));
  const r = parseRes(await computeH(getAs('admin', { year: '2026', month: '10' })));
  assert.equal(r.body.computed.absorbed_t1_cop, 630_000);
  assert.equal(r.body.computed.inherited_blend_count, 1);
});

test('factor real y costo medio del mes', async () => {
  setFake(fixture({ snapshots: [
    snap({ kg_input_net_total: 1000, kg_dried_output: 200, total_cost_cop: 4430000 }),
    snap({ kg_input_net_total: 1000, kg_dried_output: 180, total_cost_cop: 6630000 }),
  ] }));
  const r = parseRes(await computeH(getAs('admin', { year: '2026', month: '10' })));
  const c = r.body.computed;
  assert.equal(c.kg_net_processed, 2000);
  assert.equal(c.kg_dried_produced, 380);
  assert.equal(c.real_factor, 0.19);
  assert.equal(c.avg_cost_per_kg_dried, 29105.2632);
});

test('mes y año inválidos se rechazan', async () => {
  setFake(fixture());
  assert.equal(parseRes(await computeH(getAs('admin', { year: '2026', month: '13' }))).body.code, 'INVALID_MONTH');
  assert.equal(parseRes(await computeH(getAs('admin', { year: '1999', month: '1' }))).body.code, 'INVALID_YEAR');
});

test('la finca no ve el costeo', async () => {
  setFake(fixture());
  assert.equal(parseRes(await computeH(getAs('finca', { year: '2026', month: '10' }))).status, 403);
  assert.equal(parseRes(await reportH(getAs('finca'))).status, 403);
});

// ══════════════════════════════════════════════════════════════
// GUARDAR EL CIERRE
// ══════════════════════════════════════════════════════════════

test('guardar recalcula en el servidor: no confía en la pantalla', async () => {
  const fake = fixture({ snapshots: [snap({ t1_cost_cop: 630000, t2_cost_cop: 6000000 })] });
  setFake(fake);

  // La pantalla manda totales mentirosos; deben ignorarse.
  const r = parseRes(await saveH(asAdmin({
    year: 2026, month: 10, actual_mandate_cop: 10000000,
    absorbed_t1_cop: 1, absorbed_t2_cop: 1,
  })));
  assert.equal(r.status, 201);
  const row = fake._db.monthly_cost_closures[0];
  assert.equal(Number(row.absorbed_t1_cop), 630_000);
  assert.equal(Number(row.absorbed_t2_cop), 6_000_000);
});

test('guardar dos veces el mismo mes actualiza, no duplica', async () => {
  const fake = fixture({ snapshots: [snap()] });
  setFake(fake);

  const a = parseRes(await saveH(asAdmin({ year: 2026, month: 10, actual_mandate_cop: 1000000 })));
  assert.equal(a.body.created, true);
  const b = parseRes(await saveH(asAdmin({ year: 2026, month: 10, actual_mandate_cop: 2000000 })));
  assert.equal(b.body.created, false);
  assert.equal(fake._db.monthly_cost_closures.length, 1);
  assert.equal(Number(fake._db.monthly_cost_closures[0].actual_mandate_cop), 2000000);
});

test('se puede guardar sin mandato todavía', async () => {
  const fake = fixture({ snapshots: [snap()] });
  setFake(fake);
  const r = parseRes(await saveH(asAdmin({ year: 2026, month: 10 })));
  assert.equal(r.status, 201);
  assert.equal(fake._db.monthly_cost_closures[0].actual_mandate_cop, null);
});

test('montos negativos se rechazan', async () => {
  setFake(fixture({ snapshots: [snap()] }));
  assert.equal(parseRes(await saveH(asAdmin({ year: 2026, month: 10, actual_mandate_cop: -5 }))).body.code, 'INVALID_MANDATE');
  assert.equal(parseRes(await saveH(asAdmin({ year: 2026, month: 10, byproduct_revenue_cop: -5 }))).body.code, 'INVALID_BYPRODUCT_REVENUE');
});

test('forest no puede guardar el cierre (es de admin)', async () => {
  setFake(fixture({ snapshots: [snap()] }));
  assert.equal(parseRes(await saveH(postEvent({ year: 2026, month: 10 }, { role: 'forest' }))).status, 403);
});

// ══════════════════════════════════════════════════════════════
// ACUMULADO DEL AÑO
// ══════════════════════════════════════════════════════════════

test('el acumulado solo suma meses con mandato digitado', async () => {
  setFake(fixture({ closures: [
    { id: 'a', year: 2026, month: 8, absorbed_t1_cop: 100, absorbed_t2_cop: 200,
      absorbed_total_cop: 300, actual_mandate_cop: 1000, mandate_difference_cop: 700,
      byproduct_revenue_cop: 50, kg_net_processed: 10, kg_dried_produced: 2 },
    { id: 'b', year: 2026, month: 9, absorbed_t1_cop: 400, absorbed_t2_cop: 0,
      absorbed_total_cop: 400, actual_mandate_cop: null, mandate_difference_cop: null,
      byproduct_revenue_cop: null, kg_net_processed: 20, kg_dried_produced: 4 },
  ] }));
  const r = parseRes(await listH(getAs('forest')));
  assert.equal(r.status, 200);
  assert.equal(r.body.ytd.months, 1);
  assert.equal(r.body.ytd.absorbed_total_cop, 300);
  assert.equal(r.body.ytd.mandate_difference_cop, 700);
  assert.equal(r.body.ytd.difference_pct_of_mandate, 0.7);
  // Los kg sí suman todos los meses: son volumen, no plata.
  assert.equal(r.body.ytd.kg_net_processed, 30);
});

test('sin meses con mandato, el acumulado es null (no cero engañoso)', async () => {
  setFake(fixture({ closures: [
    { id: 'b', year: 2026, month: 9, absorbed_total_cop: 400, actual_mandate_cop: null,
      kg_net_processed: 20, kg_dried_produced: 4 },
  ] }));
  const r = parseRes(await listH(getAs('admin')));
  assert.equal(r.body.ytd, null);
});

// ══════════════════════════════════════════════════════════════
// REPORTE POR LOTE
// ══════════════════════════════════════════════════════════════

test('el reporte clasifica el origen desde el snapshot congelado', async () => {
  setFake(fixture({ snapshots: [
    snap({ production_lot_id: 'lot-1', kg_input_net_own: 1000, kg_input_net_purchased: 0 }),
    snap({ production_lot_id: 'lot-1', kg_input_net_own: 0, kg_input_net_purchased: 1000,
      snapshot_date: '2026-10-16' }),
    snap({ production_lot_id: 'lot-1', kg_input_net_own: 500, kg_input_net_purchased: 500,
      snapshot_date: '2026-10-17' }),
    snap({ production_lot_id: 'lot-1', source_kind: 'inherited_blend',
      kg_input_net_own: 0, kg_input_net_purchased: 0, snapshot_date: '2026-10-18' }),
  ] }));
  const r = parseRes(await reportH(getAs('forest')));
  assert.equal(r.status, 200);
  const origins = r.body.lots.map((l) => l.origin).sort();
  assert.deepEqual(origins, ['comprado', 'mezcla', 'mixto', 'propio']);
});

test('el reporte trae el factor real Y el factor_rendimiento, sin confundirlos', async () => {
  setFake(fixture({ snapshots: [snap({ real_factor_dried_per_input: 0.2065 })] }));
  const r = parseRes(await reportH(getAs('admin')));
  const l = r.body.lots[0];
  assert.equal(l.real_factor, 0.2065);          // kg seco / kg neto entrado
  assert.equal(l.factor_rendimiento, 92.1);     // kg pergamino por saco de 70
  assert.equal(l.cost_per_kg_dried, 22150);
});

test('el reporte excluye anulados salvo que se pidan', async () => {
  setFake(fixture({ snapshots: [
    snap(),
    snap({ voided_at: '2026-10-20T00:00:00Z', snapshot_date: '2026-10-16' }),
  ] }));
  assert.equal(parseRes(await reportH(getAs('admin'))).body.lots.length, 1);
  assert.equal(parseRes(await reportH(getAs('admin', { include_voided: 'true' }))).body.lots.length, 2);
});

test('el reporte filtra por rango de fechas', async () => {
  setFake(fixture({ snapshots: [
    snap({ snapshot_date: '2026-09-15' }),
    snap({ snapshot_date: '2026-10-15' }),
    snap({ snapshot_date: '2026-11-15' }),
  ] }));
  const r = parseRes(await reportH(getAs('admin', { from: '2026-10-01', to: '2026-10-31' })));
  assert.equal(r.body.lots.length, 1);
});
