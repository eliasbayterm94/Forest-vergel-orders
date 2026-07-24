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

test('no se puede editar un despacho confirmado', async () => {
  setFake(fixture('confirmed'));
  const r = parseRes(await handler(postEvent({
    shipment_id: SHIP, header: { driver_name: 'X' },
  }), {}));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'NOT_A_DRAFT');
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
