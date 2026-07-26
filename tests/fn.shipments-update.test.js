'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const { loadHandler, setFake, postEvent, parseRes } = require('./helpers/fn-harness');

const SHIP = 'bbbbbbbb-0000-0000-0000-000000000001';

function fixture(status = 'draft') {
  return createFakeSupabase({
    shipments: [{ id: SHIP, shipment_code: 'DSP-1', status,
      destino_kind: null, driver_name: null, notes: null }],
    shipment_lots: [{ id: 'sl1', shipment_id: SHIP, production_lot_id: 'L1',
      num_sacos: null, num_lonas: null, empaque_interior: null, color_cinta: null, observaciones: null }],
  });
}

const handler = loadHandler('shipments-update', fixture());

test('editar borrador: patch de header y línea', async () => {
  const fake = fixture();
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    shipment_id: SHIP,
    header: { destino_kind: 'Tribox', driver_name: 'Ana', notes: 'listo mañana' },
    lines: [{ id: 'sl1', num_sacos: 4, num_lonas: 2, empaque_interior: 'bolsa', color_cinta: '#00FF00', observaciones: 'urgente' }],
  }), {}));
  assert.equal(r.status, 200);
  assert.equal(fake._db.shipments[0].destino_kind, 'Tribox');
  assert.equal(fake._db.shipments[0].driver_name, 'Ana');
  assert.equal(fake._db.shipments[0].notes, 'listo mañana');
  const line = fake._db.shipment_lots[0];
  assert.equal(line.num_sacos, 4);
  assert.equal(line.num_lonas, 2);
  assert.equal(line.empaque_interior, 'bolsa');
  assert.equal(line.color_cinta, '#00FF00');
  assert.equal(line.observaciones, 'urgente');
});

test('en confirmado SÍ se puede editar la logística (agregar PP\'s)', async () => {
  const fake = fixture('confirmed');
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    shipment_id: SHIP, header: { driver_name: 'X' },
    lines: [{ id: 'sl1', codigo_trilladora: 'PP-9001' }],
  }), {}));
  assert.equal(r.status, 200);
  assert.equal(fake._db.shipments[0].driver_name, 'X');
  assert.equal(fake._db.shipment_lots[0].codigo_trilladora, 'PP-9001');
});

test('en confirmado NO se puede editar el kg (KG_LOCKED)', async () => {
  const fake = createFakeSupabase({
    shipments: [{ id: SHIP, shipment_code: 'DSP-1', status: 'confirmed' }],
    shipment_lots: [{ id: 'sl1', shipment_id: SHIP, production_lot_id: 'L1', lot_partial_id: null,
      kg_dried_shipped: 200, kg_dried_merma: null, lot_partials: null }],
    production_lots: [{ id: 'L1', kg_dried_output: 350, bache_code: '29', lot_code: 'L' }],
    lot_blend_components: [],
  });
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    shipment_id: SHIP, lines: [{ id: 'sl1', kg_dried_shipped: 300 }],
  }), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'KG_LOCKED');
  // El kg no cambió.
  assert.equal(fake._db.shipment_lots[0].kg_dried_shipped, 200);
});

test('empaque inválido rebota INVALID_EMPAQUE', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({
    shipment_id: SHIP, lines: [{ id: 'sl1', empaque_interior: 'vacio' }],
  }), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_EMPAQUE');
});

test('color inválido rebota INVALID_COLOR', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({
    shipment_id: SHIP, lines: [{ id: 'sl1', color_cinta: 'verde' }],
  }), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_COLOR');
});

test('línea ajena rebota LINE_NOT_IN_SHIPMENT', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({
    shipment_id: SHIP, lines: [{ id: 'otra', num_sacos: 1 }],
  }), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'LINE_NOT_IN_SHIPMENT');
});

test('destino Otro sin especificar rebota', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({
    shipment_id: SHIP, header: { destino_kind: 'Otro' },
  }), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'DESTINO_OTHER_REQUIRED');
});

// ── Editar kg (whole/by-kg) ──────────────────────────────────────

// Fixture con contexto de inventario para validar kg: bache de 350,
// borrador con una línea whole de 200.
function kgFixture() {
  return createFakeSupabase({
    shipments: [{ id: SHIP, shipment_code: 'DSP-1', status: 'draft' }],
    shipment_lots: [{
      id: 'sl1', shipment_id: SHIP, production_lot_id: 'L1', lot_partial_id: null,
      kg_dried_shipped: 200, kg_dried_merma: null, lot_partials: null,
      num_sacos: null, num_lonas: null, empaque_interior: null, color_cinta: null, observaciones: null,
    }],
    production_lots: [{ id: 'L1', kg_dried_output: 350, bache_code: '29-1000', lot_code: 'L' }],
    lot_blend_components: [],
  });
}

test('editar kg dentro del disponible actualiza la línea', async () => {
  const fake = kgFixture();
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    shipment_id: SHIP, lines: [{ id: 'sl1', kg_dried_shipped: 300 }],
  }), {}));
  assert.equal(r.status, 200);
  assert.equal(fake._db.shipment_lots[0].kg_dried_shipped, 300);
});

test('editar kg por encima del disponible rebota EXCEEDS_AVAILABLE', async () => {
  setFake(kgFixture());
  const r = parseRes(await handler(postEvent({
    shipment_id: SHIP, lines: [{ id: 'sl1', kg_dried_shipped: 400 }],
  }), {}));
  assert.equal(r.body.code, 'EXCEEDS_AVAILABLE');
});

test('editar kg a 0 rebota INVALID_KG', async () => {
  setFake(kgFixture());
  const r = parseRes(await handler(postEvent({
    shipment_id: SHIP, lines: [{ id: 'sl1', kg_dried_shipped: 0 }],
  }), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_KG');
});

test('editar kg de una línea de parcial rebota KG_NOT_EDITABLE', async () => {
  const fake = createFakeSupabase({
    shipments: [{ id: SHIP, shipment_code: 'DSP-1', status: 'draft' }],
    shipment_lots: [{
      id: 'slp', shipment_id: SHIP, production_lot_id: 'L1', lot_partial_id: 'p1',
      kg_dried_shipped: null, kg_dried_merma: null, lot_partials: { kg_dried: 100 },
    }],
    production_lots: [{ id: 'L1', kg_dried_output: 350, bache_code: '29', lot_code: 'L' }],
    lot_blend_components: [],
  });
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    shipment_id: SHIP, lines: [{ id: 'slp', kg_dried_shipped: 120 }],
  }), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'KG_NOT_EDITABLE');
});

test('editar kg + logística en la misma llamada', async () => {
  const fake = kgFixture();
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    shipment_id: SHIP, lines: [{ id: 'sl1', kg_dried_shipped: 250, num_sacos: 6, empaque_interior: 'grainpro' }],
  }), {}));
  assert.equal(r.status, 200);
  const line = fake._db.shipment_lots[0];
  assert.equal(line.kg_dried_shipped, 250);
  assert.equal(line.num_sacos, 6);
  assert.equal(line.empaque_interior, 'grainpro');
});
