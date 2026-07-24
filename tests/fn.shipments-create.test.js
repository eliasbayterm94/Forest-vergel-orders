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
