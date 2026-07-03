'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const { loadHandler, setFake, postEvent, parseRes } = require('./helpers/fn-harness');

const LOT = 'aaaaaaaa-0000-0000-0000-000000000001';
const ORDER = 'bbbbbbbb-0000-0000-0000-000000000001';

function fixture(overrides = {}) {
  return createFakeSupabase({
    production_lots: [{ id: LOT, status: overrides.lotStatus || 'Ready' }],
    demand_orders: [{
      id: ORDER, status: overrides.orderStatus || 'Accepted',
      kg_green_accepted: 500, in_production_at: null,
    }],
    lot_order_assignments: [],
  });
}

const handler = loadHandler('lot-assignments-create', fixture());

test('validaciones básicas', async () => {
  setFake(fixture());
  let r = parseRes(await handler(postEvent({ assignments: [{ demand_order_id: ORDER, kg_green_allocated: 100 }] }), {}));
  assert.equal(r.body.code, 'LOT_ID_REQUIRED');

  setFake(fixture());
  r = parseRes(await handler(postEvent({ production_lot_id: LOT, assignments: [] }), {}));
  assert.equal(r.body.code, 'ASSIGNMENTS_REQUIRED');

  setFake(fixture());
  r = parseRes(await handler(postEvent({
    production_lot_id: LOT,
    assignments: [{ demand_order_id: ORDER, kg_green_allocated: 0 }],
  }), {}));
  assert.equal(r.body.code, 'INVALID_KG');
});

test('el trigger de capacidad del lote se mapea a LOT_OVER_ALLOCATED', async () => {
  const fake = fixture();
  fake.failOnInsert('lot_order_assignments',
    'Total lot allocations (1221.64) exceed lot capacity (671.64) for lot ' + LOT);
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    production_lot_id: LOT,
    assignments: [{ demand_order_id: ORDER, kg_green_allocated: 671.64 }],
  }), {}));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'LOT_OVER_ALLOCATED');
});

test('happy path: inserta y promueve Accepted → InProduction', async () => {
  const fake = fixture();
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    production_lot_id: LOT,
    assignments: [{ demand_order_id: ORDER, kg_green_allocated: 300 }],
  }), {}));
  assert.equal(r.status, 201);
  assert.equal(r.body.assignments.length, 1);
  assert.equal(fake._db.lot_order_assignments.length, 1);
  // Orden promovida
  assert.equal(fake._db.demand_orders[0].status, 'InProduction');
  assert.ok(fake._db.demand_orders[0].in_production_at);
});

test('orden ya InProduction no se re-promueve ni truena', async () => {
  const fake = fixture({ orderStatus: 'InProduction' });
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    production_lot_id: LOT,
    assignments: [{ demand_order_id: ORDER, kg_green_allocated: 100 }],
  }), {}));
  assert.equal(r.status, 201);
  assert.equal(fake._db.demand_orders[0].status, 'InProduction');
});
