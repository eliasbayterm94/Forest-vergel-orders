'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const { loadHandler, setFake, postEvent, parseRes } = require('./helpers/fn-harness');

const LOT = 'aaaaaaaa-0000-0000-0000-000000000001';

// Bache Ready de 350 kg seco sin parciales — el escenario del bug
// "puse 200 y despachó 350".
function fixture(overrides = {}) {
  return createFakeSupabase({
    production_lots: [{
      id: LOT, lot_code: 'LOT-1', bache_code: '29-1000',
      status: overrides.lotStatus || 'Ready',
      kg_dried_output: 350, kg_green_actual: 245, kg_green_expected: 207,
      lot_partials: overrides.lot_partials || [],
    }],
    shipment_lots: overrides.shipment_lots || [],
    lot_blend_components: overrides.lot_blend_components || [],
    shipments: [],
    lot_order_assignments: [],
    demand_orders: [],
  });
}

const handler = loadHandler('shipments-create', fixture());

test('items requeridos', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({}), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'ITEMS_REQUIRED');
});

test('lote no-Ready rebota', async () => {
  setFake(fixture({ lotStatus: 'Drying' }));
  const r = parseRes(await handler(postEvent({
    items: [{ production_lot_id: LOT, partial_ids: null }],
  }), {}));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'LOT_NOT_READY');
});

test('despacho parcial por kg guarda EXACTAMENTE los kg pedidos (bug 350/200)', async () => {
  const fake = fixture();
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    items: [{ production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 200, num_sacos: 5 }],
    destino_kind: 'Vertical', shipment_code: 'DSP-TEST-1',
  }), {}));
  assert.equal(r.status, 200);

  const link = fake._db.shipment_lots[0];
  assert.equal(link.kg_dried_shipped, 200);   // NO 350
  assert.equal(link.num_sacos, 5);
  // El bache NO pasa a Delivered — quedan 150 en bodega
  assert.equal(fake._db.production_lots[0].status, 'Ready');
});

test('pedir más kg de los disponibles rebota EXCEEDS_AVAILABLE', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({
    items: [{ production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 400 }],
  }), {}));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'EXCEEDS_AVAILABLE');
});

test('el disponible descuenta despachos previos parciales', async () => {
  // Ya salieron 200; disponible = 150. Pedir 200 más debe rebotar.
  setFake(fixture({
    shipment_lots: [{ production_lot_id: LOT, lot_partial_id: null, kg_dried_shipped: 200 }],
  }));
  const r = parseRes(await handler(postEvent({
    items: [{ production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 200 }],
  }), {}));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'EXCEEDS_AVAILABLE');
});

test('despachar el resto exacto marca Delivered', async () => {
  const fake = fixture({
    shipment_lots: [{ production_lot_id: LOT, lot_partial_id: null, kg_dried_shipped: 200 }],
  });
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    items: [{ production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 150 }],
  }), {}));
  assert.equal(r.status, 200);
  assert.equal(fake._db.production_lots[0].status, 'Delivered');
  assert.ok(fake._db.production_lots[0].delivered_date);
});

test('lote completamente despachado rebota LOT_ALREADY_SHIPPED', async () => {
  setFake(fixture({
    shipment_lots: [{ production_lot_id: LOT, lot_partial_id: null, kg_dried_shipped: 350 }],
    lotStatus: 'Ready',   // aunque siga Ready por datos raros, el kg manda
  }));
  const r = parseRes(await handler(postEvent({
    items: [{ production_lot_id: LOT, partial_ids: null }],
  }), {}));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'LOT_ALREADY_SHIPPED');
});

test('lote con parciales exige partial_ids', async () => {
  setFake(fixture({
    lot_partials: [{ id: 'p1', parcial_letter: 'A', kg_green_yield: 100, rejected_at: null }],
  }));
  const r = parseRes(await handler(postEvent({
    items: [{ production_lot_id: LOT, partial_ids: null }],
  }), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'PARTIAL_IDS_REQUIRED');
});

test('empaque: lonas, empaque_interior, color y observaciones se guardan', async () => {
  const fake = fixture();
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    items: [{
      production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 200,
      num_sacos: 3, num_lonas: 2, empaque_interior: 'grainpro',
      color_cinta: '#FF00AA', observaciones: 'Cinta rosada, va a trilla fina',
    }],
    destino_kind: 'Vertical',
  }), {}));
  assert.equal(r.status, 200);
  const link = fake._db.shipment_lots[0];
  assert.equal(link.num_sacos, 3);
  assert.equal(link.num_lonas, 2);
  assert.equal(link.empaque_interior, 'grainpro');
  assert.equal(link.color_cinta, '#FF00AA');
  assert.equal(link.observaciones, 'Cinta rosada, va a trilla fina');
});

test('empaque: campos vacíos quedan null', async () => {
  const fake = fixture();
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    items: [{
      production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 200,
      num_lonas: '', empaque_interior: '', color_cinta: '', observaciones: '',
    }],
  }), {}));
  assert.equal(r.status, 200);
  const link = fake._db.shipment_lots[0];
  assert.equal(link.num_lonas, null);
  assert.equal(link.empaque_interior, null);
  assert.equal(link.color_cinta, null);
  assert.equal(link.observaciones, null);
});

test('empaque_interior inválido rebota INVALID_EMPAQUE', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({
    items: [{ production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 200, empaque_interior: 'vacio' }],
  }), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_EMPAQUE');
});

test('color_cinta inválido rebota INVALID_COLOR', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({
    items: [{ production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 200, color_cinta: 'rosado' }],
  }), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_COLOR');
});

// ── Peso real de báscula (close_lot) ─────────────────────────────

test('peso real: báscula por debajo cierra el bache y registra merma', async () => {
  const fake = fixture();
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    items: [{ production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 348, close_lot: true }],
  }), {}));
  assert.equal(r.status, 200);
  const link = fake._db.shipment_lots[0];
  assert.equal(link.kg_dried_shipped, 348);
  assert.equal(link.kg_dried_merma, 2);
  const lot = fake._db.production_lots[0];
  assert.equal(lot.status, 'Delivered');           // cierra aunque falten 2 kg
  assert.match(lot.notes || '', /merma de 2 kg/);  // bitácora
});

test('peso real: báscula por encima (≤3%) cierra con ganancia', async () => {
  const fake = fixture();
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    items: [{ production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 353, close_lot: true }],
  }), {}));
  assert.equal(r.status, 200);
  const link = fake._db.shipment_lots[0];
  assert.equal(link.kg_dried_shipped, 353);
  assert.equal(link.kg_dried_merma, -3);
  assert.equal(fake._db.production_lots[0].status, 'Delivered');
  assert.match(fake._db.production_lots[0].notes || '', /ganancia de 3 kg/);
});

test('peso real: diferencia >3% exige confirmación (override_peso_real)', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({
    items: [{ production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 300, close_lot: true }],
  }), {}));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'PESO_REAL_CONFIRM_REQUIRED');
  assert.equal(r.body.kg_registered, 350);
  assert.equal(r.body.kg_real, 300);
  assert.equal(r.body.kg_diff, 50);

  // Con override sí pasa y cierra
  const fake = fixture();
  setFake(fake);
  const r2 = parseRes(await handler(postEvent({
    items: [{ production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 300, close_lot: true }],
    override_peso_real: true,
  }), {}));
  assert.equal(r2.status, 200);
  assert.equal(fake._db.shipment_lots[0].kg_dried_merma, 50);
  assert.equal(fake._db.production_lots[0].status, 'Delivered');
});

test('peso real: báscula >3% por encima rebota EXCEEDS_AVAILABLE', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({
    items: [{ production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 380, close_lot: true }],
  }), {}));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'EXCEEDS_AVAILABLE');
});

test('peso real: la merma descuenta del disponible en despachos posteriores', async () => {
  // Bache ya cerrado con báscula 348 + merma 2 → disponible 0.
  setFake(fixture({
    shipment_lots: [{ production_lot_id: LOT, lot_partial_id: null, kg_dried_shipped: 348, kg_dried_merma: 2 }],
  }));
  const r = parseRes(await handler(postEvent({
    items: [{ production_lot_id: LOT, partial_ids: null }],
  }), {}));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'LOT_ALREADY_SHIPPED');
});

// ── División P1/P2 ───────────────────────────────────────────────

test('división: dos líneas del mismo bache reciben P1 y P2', async () => {
  const fake = fixture();
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    items: [
      { production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 150, split: true, num_sacos: 2 },
      { production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 200, split: true, num_sacos: 3 },
    ],
  }), {}));
  assert.equal(r.status, 200);
  const links = fake._db.shipment_lots;
  assert.equal(links.length, 2);
  assert.equal(links[0].split_label, 'P1');
  assert.equal(links[0].kg_dried_shipped, 150);
  assert.equal(links[1].split_label, 'P2');
  assert.equal(links[1].kg_dried_shipped, 200);
  // 150 + 200 = 350 → bache completo despachado
  assert.equal(fake._db.production_lots[0].status, 'Delivered');
});

test('división parcial: el bache queda Ready con el saldo en bodega', async () => {
  const fake = fixture();
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    items: [
      { production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 100, split: true },
      { production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 100, split: true },
    ],
  }), {}));
  assert.equal(r.status, 200);
  assert.equal(fake._db.production_lots[0].status, 'Ready');  // quedan 150
});

test('división: la suma de líneas no puede exceder el disponible', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({
    items: [
      { production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 200, split: true },
      { production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 200, split: true },
    ],
  }), {}));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'EXCEEDS_AVAILABLE');
});

test('división: la numeración continúa entre despachos (P2 previo → P3)', async () => {
  const fake = fixture({
    shipment_lots: [
      { production_lot_id: LOT, lot_partial_id: null, kg_dried_shipped: 60, split_label: 'P1' },
      { production_lot_id: LOT, lot_partial_id: null, kg_dried_shipped: 90, split_label: 'P2' },
    ],
  });
  setFake(fake);
  // Sin flag split: el bache ya tiene divisiones → hereda numeración.
  const r = parseRes(await handler(postEvent({
    items: [{ production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 100 }],
  }), {}));
  assert.equal(r.status, 200);
  const newLink = fake._db.shipment_lots[2];
  assert.equal(newLink.split_label, 'P3');
  assert.equal(fake._db.production_lots[0].status, 'Ready');  // 250 de 350
});

test('división: una sola línea con split=true recibe P1', async () => {
  const fake = fixture();
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    items: [{ production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 200, split: true }],
  }), {}));
  assert.equal(r.status, 200);
  assert.equal(fake._db.shipment_lots[0].split_label, 'P1');
});

test('kg consumido en mezclas también descuenta del disponible', async () => {
  // 350 total − 300 en mezcla = 50 disponibles. Pedir 100 rebota.
  setFake(fixture({
    lot_blend_components: [{ source_lot_id: LOT, kg_dried_used: 300 }],
  }));
  const r = parseRes(await handler(postEvent({
    items: [{ production_lot_id: LOT, partial_ids: null, kg_dried_to_ship: 100 }],
  }), {}));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'EXCEEDS_AVAILABLE');
});
