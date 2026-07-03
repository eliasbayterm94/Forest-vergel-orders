'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const { loadHandler, setFake, postEvent, parseRes } = require('./helpers/fn-harness');

const ORDER = 'bbbbbbbb-0000-0000-0000-000000000001';

function fixture(order = {}) {
  return createFakeSupabase({
    demand_orders: [{
      id: ORDER, order_code: 'PED-2026-0042', status: 'InProduction',
      comments: 'Cliente exige notas a chocolate', completed_at: null,
      ...order,
    }],
  });
}

const handler = loadHandler('demand-orders-mark-complete', fixture());

test('motivo requerido', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({ order_id: ORDER }), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'REASON_REQUIRED');
});

test('estados no cerrables rebotan (Pending, Completed, Cancelled)', async () => {
  for (const status of ['Pending', 'Completed', 'Cancelled', 'Rejected']) {
    setFake(fixture({ status }));
    const r = parseRes(await handler(postEvent({ order_id: ORDER, reason: 'razón del cierre' }), {}));
    assert.equal(r.status, 409, `status ${status} debería rebotar`);
    assert.equal(r.body.code, 'NOT_CLOSEABLE');
  }
});

test('happy path: cierra y anexa tag con operario preservando comments previos', async () => {
  const fake = fixture();
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    order_id: ORDER,
    reason: 'Despachado fuera del sistema, confirmado con cliente',
    operator_name: 'Elias B.',
  }, { role: 'forest' }), {}));
  assert.equal(r.status, 200);
  assert.equal(r.body.order.status, 'Completed');
  assert.ok(r.body.order.completed_at);

  const o = fake._db.demand_orders[0];
  assert.match(o.comments, /^Cliente exige notas a chocolate\n/);
  assert.match(o.comments, /\[Cerrado manualmente por forest \(Elias B\.\) · \d{4}-\d{2}-\d{2}\] Despachado fuera del sistema/);
});

test('roles finca y forest ambos pueden cerrar', async () => {
  for (const role of ['finca', 'forest', 'admin']) {
    setFake(fixture());
    const r = parseRes(await handler(postEvent({ order_id: ORDER, reason: 'razón del cierre' }, { role }), {}));
    assert.equal(r.status, 200, `rol ${role} debería poder cerrar`);
  }
});
