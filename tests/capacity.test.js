'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeCapacity } = require('../netlify/functions/_lib/capacity');

const LEAD = { Natural: 12, Honey: 8, Lavado: 8 };

test('empty orders → empty result', () => {
  const r = computeCapacity({
    orders: [], activeLots: [], dryingDaysByProcess: LEAD, todayYmd: '2026-05-09',
  });
  assert.equal(r.orders.length, 0);
  assert.equal(r.aggregate.order_count, 0);
  assert.equal(r.aggregate.total_kg_green, 0);
  assert.deepEqual(r.weekly_load, []);
});

test('single Natural order — latest_drying_start = delivery − 12d', () => {
  const r = computeCapacity({
    orders: [{
      id: 'o1', order_code: 'FV-2026-0001', reference_id: 'r1', reference_name: 'Ref A',
      kg_green_required: 200, kg_green_accepted: 200,
      max_delivery_date: '2026-06-01', process_type: 'Natural',
    }],
    activeLots: [], dryingDaysByProcess: LEAD, todayYmd: '2026-05-09',
  });
  assert.equal(r.orders[0].latest_drying_start_date, '2026-05-20');
  assert.equal(r.orders[0].kg_cherry_required, 1530);  // 200 × 7.65
  assert.equal(r.orders[0].urgency, 'normal');
  assert.equal(r.aggregate.total_kg_green, 200);
  assert.equal(r.aggregate.total_kg_cherry, 1530);
  assert.equal(r.aggregate.earliest_drying_start_date, '2026-05-20');
});

test('two orders, different weeks → two weekly buckets', () => {
  const r = computeCapacity({
    orders: [
      {
        id: 'o1', order_code: 'FV-2026-0001', reference_id: 'r1', reference_name: 'A',
        kg_green_required: 100, kg_green_accepted: 100,
        max_delivery_date: '2026-06-01', process_type: 'Natural',  // start 2026-05-20 (W21)
      },
      {
        id: 'o2', order_code: 'FV-2026-0002', reference_id: 'r2', reference_name: 'B',
        kg_green_required: 200, kg_green_accepted: 200,
        max_delivery_date: '2026-06-15', process_type: 'Honey',     // start 2026-06-07 (W23)
      },
    ],
    activeLots: [], dryingDaysByProcess: LEAD, todayYmd: '2026-05-09',
  });
  assert.equal(r.weekly_load.length, 2);
  const w21 = r.weekly_load.find((w) => w.iso_week === 21);
  const w23 = r.weekly_load.find((w) => w.iso_week === 23);
  assert.ok(w21 && w23);
  assert.equal(w21.selected_orders_kg_green, 100);
  assert.equal(w21.selected_orders_kg_cherry, 765);
  assert.equal(w23.selected_orders_kg_green, 200);
  assert.equal(w23.selected_orders_kg_cherry, 1530);
});

test('active queue overlay adds kg_cherry to its week bucket', () => {
  const r = computeCapacity({
    orders: [{
      id: 'o1', order_code: 'FV-2026-0001', reference_id: 'r1', reference_name: 'A',
      kg_green_required: 100, kg_green_accepted: 100,
      max_delivery_date: '2026-06-01', process_type: 'Natural',  // 2026-05-20 (W21)
    }],
    activeLots: [{
      id: 'L1', lot_code: 'LOT-2026-0001', status: 'Drying',
      kg_cherry_input: 500, drying_start_date: '2026-05-21',
    }],
    dryingDaysByProcess: LEAD, todayYmd: '2026-05-09',
  });
  const w21 = r.weekly_load.find((w) => w.iso_week === 21);
  assert.equal(w21.active_queue_kg_cherry, 500);
  assert.deepEqual(w21.active_queue_lot_codes, ['LOT-2026-0001']);
});

test('Delivered/Ready lots are excluded from active overlay', () => {
  const r = computeCapacity({
    orders: [{
      id: 'o1', order_code: 'FV-2026-0001', reference_id: 'r1', reference_name: 'A',
      kg_green_required: 100, kg_green_accepted: 100,
      max_delivery_date: '2026-06-01', process_type: 'Natural',
    }],
    activeLots: [
      { id: 'L1', lot_code: 'A', status: 'Ready',     kg_cherry_input: 100, start_date: '2026-05-20' },
      { id: 'L2', lot_code: 'B', status: 'Delivered', kg_cherry_input: 100, start_date: '2026-05-20' },
    ],
    dryingDaysByProcess: LEAD, todayYmd: '2026-05-09',
  });
  const w21 = r.weekly_load.find((w) => w.iso_week === 21);
  assert.equal(w21.active_queue_kg_cherry, 0);
});

test('urgency past — order with delivery already missed', () => {
  const r = computeCapacity({
    orders: [{
      id: 'o1', order_code: 'FV-2026-0001', reference_id: 'r1', reference_name: 'A',
      kg_green_required: 100, kg_green_accepted: 100,
      max_delivery_date: '2026-05-15', process_type: 'Natural', // start 2026-05-03 < today
    }],
    activeLots: [], dryingDaysByProcess: LEAD, todayYmd: '2026-05-09',
  });
  assert.equal(r.orders[0].urgency, 'past');
});
