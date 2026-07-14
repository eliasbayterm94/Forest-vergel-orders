'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const { loadHandler, setFake, postEvent, parseRes } = require('./helpers/fn-harness');

const ORDER = 'bbbbbbbb-0000-0000-0000-000000000001';
const LOT = 'aaaaaaaa-0000-0000-0000-000000000001';

function fixture(order = {}, assigns = []) {
  return createFakeSupabase({
    demand_orders: [{
      id: ORDER, order_code: 'PED-2026-0042', status: 'InProduction',
      comments: null, cancelled_at: null,
      ...order,
    }],
    lot_order_assignments: assigns,
  });
}

const handler = loadHandler('demand-orders-cancel', fixture());

test('finca puede cancelar (antes era solo forest/admin)', async () => {
  for (const role of ['finca', 'forest', 'admin']) {
    setFake(fixture());
    const r = parseRes(await handler(postEvent({ order_id: ORDER, reason: 'ya no va' }, { role }), {}));
    assert.equal(r.status, 200, `rol ${role} debería poder cancelar`);
    assert.equal(r.body.order.status, 'Cancelled');
  }
});

test('estados terminales rebotan NOT_CANCELLABLE', async () => {
  for (const status of ['Completed', 'Cancelled', 'Rejected']) {
    setFake(fixture({ status }));
    const r = parseRes(await handler(postEvent({ order_id: ORDER, reason: 'x' }), {}));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'NOT_CANCELLABLE');
  }
});

test('asignaciones activas (no Delivered) bloquean con detalle de baches', async () => {
  setFake(fixture({}, [
    { id: 'a1', demand_order_id: ORDER, kg_green_allocated: 300,
      production_lots: { bache_code: '29-1000', lot_code: 'LOT-1', status: 'Ready' } },
  ]));
  const r = parseRes(await handler(postEvent({ order_id: ORDER, reason: 'x' }), {}));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'HAS_LOT_ASSIGNMENTS');
  assert.equal(r.body.assignments[0].bache_code, '29-1000');
});

test('asignaciones a lotes ya Delivered NO bloquean', async () => {
  const fake = fixture({}, [
    { id: 'a1', demand_order_id: ORDER, kg_green_allocated: 300,
      production_lots: { bache_code: '29-1000', lot_code: 'LOT-1', status: 'Delivered' } },
  ]);
  setFake(fake);
  const r = parseRes(await handler(postEvent({ order_id: ORDER, reason: 'cliente desistió' }), {}));
  assert.equal(r.status, 200);
  assert.equal(fake._db.demand_orders[0].status, 'Cancelled');
});

test('tag de auditoría con rol + operario, preservando comments previos', async () => {
  const fake = fixture({ comments: 'Nota previa' });
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    order_id: ORDER, reason: 'cliente desistió',
    operator_name: 'María R.',
  }, { role: 'finca' }), {}));
  assert.equal(r.status, 200);
  const o = fake._db.demand_orders[0];
  assert.match(o.comments, /^Nota previa\n/);
  assert.match(o.comments, /\[Cancelado por finca \(María R\.\) · \d{4}-\d{2}-\d{2}\] cliente desistió/);
  assert.ok(o.cancelled_at);
});
