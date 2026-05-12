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
  // Con accepted_at en la misma semana ISO que el latest_drying_start,
  // la carga no se reparte hacia atras y queda concentrada en esa
  // semana — escenario que verifica el bucket por pedido.
  const r = computeCapacity({
    orders: [
      {
        id: 'o1', order_code: 'FV-2026-0001', reference_id: 'r1', reference_name: 'A',
        kg_green_required: 100, kg_green_accepted: 100,
        max_delivery_date: '2026-06-01', process_type: 'Natural',  // start 2026-05-20 (W21)
        accepted_at: '2026-05-18',  // lunes W21
      },
      {
        id: 'o2', order_code: 'FV-2026-0002', reference_id: 'r2', reference_name: 'B',
        kg_green_required: 200, kg_green_accepted: 200,
        max_delivery_date: '2026-06-15', process_type: 'Honey',     // start 2026-06-07 (W23)
        accepted_at: '2026-06-01',  // lunes W23
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

test('order accepted weeks before delivery → cherry distributed across weeks', () => {
  // Pedido aceptado 3 semanas antes del latest_drying_start → la
  // cereza se reparte parejo entre esas 3 semanas + la de inicio.
  const r = computeCapacity({
    orders: [{
      id: 'o1', order_code: 'FV-1', reference_id: 'r1', reference_name: 'A',
      kg_green_required: 300, kg_green_accepted: 300,  // 2295 kg cereza
      max_delivery_date: '2026-06-01', process_type: 'Natural',  // start 2026-05-20 (W21)
      accepted_at: '2026-04-27',  // lunes W18  → spread W18/W19/W20/W21 (4 semanas)
    }],
    activeLots: [], dryingDaysByProcess: LEAD, todayYmd: '2026-04-27',
  });
  assert.equal(r.weekly_load.length, 4);
  for (const b of r.weekly_load) {
    // 2295 / 4 = 573.75 cereza por semana
    assert.equal(b.selected_orders_kg_cherry, 573.75);
    assert.equal(b.selected_orders_kg_green,  75);
  }
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

test('rejected partials in active lot bubble up as kg verde lost', () => {
  const r = computeCapacity({
    orders: [],
    activeLots: [{
      id: 'L1', lot_code: 'B-23', status: 'Drying',
      kg_cherry_input: 1000, drying_start_date: '2026-05-10',
      partials: [
        { id: 'p1', kg_green_yield: 50, rejected_at: null },
        { id: 'p2', kg_green_yield: 30, rejected_at: '2026-05-12T00:00:00Z' },
        { id: 'p3', kg_green_yield: 25, rejected_at: '2026-05-13T00:00:00Z' },
      ],
    }],
    dryingDaysByProcess: LEAD, todayYmd: '2026-05-09',
  });
  const bucket = r.weekly_load.find((w) => w.active_queue_lot_codes.includes('B-23'));
  assert.ok(bucket, 'expected a bucket for B-23');
  assert.equal(bucket.active_queue_kg_cherry, 1000);
  assert.equal(bucket.active_queue_kg_green_lost_to_rejection, 55);
  assert.equal(bucket.active_queue_rejected_partial_count, 2);
});

test('lot without partials does not get loss fields populated', () => {
  const r = computeCapacity({
    orders: [],
    activeLots: [{
      id: 'L1', lot_code: 'X', status: 'Drying',
      kg_cherry_input: 500, drying_start_date: '2026-05-10',
    }],
    dryingDaysByProcess: LEAD, todayYmd: '2026-05-09',
  });
  const bucket = r.weekly_load.find((w) => w.active_queue_lot_codes.includes('X'));
  assert.equal(bucket.active_queue_kg_green_lost_to_rejection, 0);
  assert.equal(bucket.active_queue_rejected_partial_count, 0);
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


test("weekly_load bucket exposes capacity_pct + is_overloaded", () => {
  // Pedido aceptado en la misma semana que su latest_drying_start: toda
  // la cereza cae en esa unica semana. 8000 kg verde * 7.65 = 61200 kg
  // cereza pone la semana sobre 60000.
  const r = computeCapacity({
    orders: [{
      id: "o1", order_code: "FV-1", reference_id: "r1", reference_name: "A",
      kg_green_required: 8000, kg_green_accepted: 8000,
      max_delivery_date: "2026-06-01", process_type: "Natural",
      accepted_at: "2026-05-18",  // lunes W21 (misma semana que start)
    }],
    activeLots: [], dryingDaysByProcess: LEAD, todayYmd: "2026-05-09",
  });
  const b = r.weekly_load[0];
  assert.equal(b.capacity_kg, 60000);
  assert.equal(b.total_cherry_kg, 61200);
  assert.equal(b.is_overloaded, true);
  assert.equal(b.overloaded_by_kg, 1200);
  assert.ok(b.capacity_pct > 100);
});

test("weekly_load under capacity is_overloaded=false", () => {
  const r = computeCapacity({
    orders: [{
      id: "o1", order_code: "FV-1", reference_id: "r1", reference_name: "A",
      kg_green_required: 1000, kg_green_accepted: 1000,
      max_delivery_date: "2026-06-01", process_type: "Natural",
      accepted_at: "2026-05-18",
    }],
    activeLots: [], dryingDaysByProcess: LEAD, todayYmd: "2026-05-09",
  });
  assert.equal(r.weekly_load[0].is_overloaded, false);
  assert.equal(r.weekly_load[0].overloaded_by_kg, 0);
});

