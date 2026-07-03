'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const {
  revertLotsIfNotStillDelivered,
  revertOrdersIfNoLongerComplete,
} = require('../netlify/functions/_lib/shipmentRevert');

const LOT = 'aaaaaaaa-0000-0000-0000-000000000001';
const ORDER = 'bbbbbbbb-0000-0000-0000-000000000001';

// ── revertLotsIfNotStillDelivered ────────────────────────────────────

test('Delivered sin links restantes vuelve a Ready', async () => {
  const sb = createFakeSupabase({
    production_lots: [{ id: LOT, status: 'Delivered', delivered_date: '2026-06-01', lot_partials: [] }],
    shipment_lots: [],
  });
  const reverted = await revertLotsIfNotStillDelivered(sb, [LOT]);
  assert.deepEqual(reverted, [LOT]);
  assert.equal(sb._db.production_lots[0].status, 'Ready');
  assert.equal(sb._db.production_lots[0].delivered_date, null);
});

test('Delivered con OTRO whole-lot link vivo se queda Delivered', async () => {
  const sb = createFakeSupabase({
    production_lots: [{ id: LOT, status: 'Delivered', delivered_date: '2026-06-01', lot_partials: [] }],
    shipment_lots: [{ production_lot_id: LOT, lot_partial_id: null }],
  });
  const reverted = await revertLotsIfNotStillDelivered(sb, [LOT]);
  assert.deepEqual(reverted, []);
  assert.equal(sb._db.production_lots[0].status, 'Delivered');
});

test('modo parciales: sigue Delivered si TODOS los partials están shipped o rejected', async () => {
  const sb = createFakeSupabase({
    production_lots: [{
      id: LOT, status: 'Delivered', delivered_date: '2026-06-01',
      lot_partials: [
        { id: 'p1', rejected_at: null },
        { id: 'p2', rejected_at: '2026-05-30' },
      ],
    }],
    shipment_lots: [{ production_lot_id: LOT, lot_partial_id: 'p1' }],
  });
  const reverted = await revertLotsIfNotStillDelivered(sb, [LOT]);
  assert.deepEqual(reverted, []);
});

test('modo parciales: revierte si quedó un partial sin cubrir', async () => {
  const sb = createFakeSupabase({
    production_lots: [{
      id: LOT, status: 'Delivered', delivered_date: '2026-06-01',
      lot_partials: [
        { id: 'p1', rejected_at: null },
        { id: 'p2', rejected_at: null },
      ],
    }],
    shipment_lots: [{ production_lot_id: LOT, lot_partial_id: 'p1' }],   // p2 quedó libre
  });
  const reverted = await revertLotsIfNotStillDelivered(sb, [LOT]);
  assert.deepEqual(reverted, [LOT]);
});

test('lotes no-Delivered se ignoran', async () => {
  const sb = createFakeSupabase({
    production_lots: [{ id: LOT, status: 'Ready', lot_partials: [] }],
    shipment_lots: [],
  });
  const reverted = await revertLotsIfNotStillDelivered(sb, [LOT]);
  assert.deepEqual(reverted, []);
  assert.equal(sb._db.production_lots[0].status, 'Ready');
});

// ── revertOrdersIfNoLongerComplete ───────────────────────────────────

test('orden Completed que ya no cumple vuelve a InProduction', async () => {
  const sb = createFakeSupabase({
    lot_order_assignments: [
      // El lote revertido: su asignación ya no cuenta como delivered
      { production_lot_id: LOT, demand_order_id: ORDER, kg_green_allocated: 500,
        production_lots: { status: 'Ready' } },
    ],
    demand_orders: [{ id: ORDER, status: 'Completed', kg_green_accepted: 500, completed_at: '2026-06-01' }],
  });
  const reverted = await revertOrdersIfNoLongerComplete(sb, [LOT]);
  assert.deepEqual(reverted, [ORDER]);
  assert.equal(sb._db.demand_orders[0].status, 'InProduction');
  assert.equal(sb._db.demand_orders[0].completed_at, null);
});

test('orden Completed que sigue cubierta por OTRO lote Delivered no se toca', async () => {
  const OTHER = 'aaaaaaaa-0000-0000-0000-000000000002';
  const sb = createFakeSupabase({
    lot_order_assignments: [
      { production_lot_id: LOT,   demand_order_id: ORDER, kg_green_allocated: 100,
        production_lots: { status: 'Ready' } },
      { production_lot_id: OTHER, demand_order_id: ORDER, kg_green_allocated: 500,
        production_lots: { status: 'Delivered' } },
    ],
    demand_orders: [{ id: ORDER, status: 'Completed', kg_green_accepted: 500 }],
  });
  const reverted = await revertOrdersIfNoLongerComplete(sb, [LOT]);
  assert.deepEqual(reverted, []);
  assert.equal(sb._db.demand_orders[0].status, 'Completed');
});

test('órdenes no-Completed se ignoran', async () => {
  const sb = createFakeSupabase({
    lot_order_assignments: [
      { production_lot_id: LOT, demand_order_id: ORDER, kg_green_allocated: 500,
        production_lots: { status: 'Ready' } },
    ],
    demand_orders: [{ id: ORDER, status: 'InProduction', kg_green_accepted: 500 }],
  });
  const reverted = await revertOrdersIfNoLongerComplete(sb, [LOT]);
  assert.deepEqual(reverted, []);
});

test('lista vacía de lotes → sin trabajo', async () => {
  const sb = createFakeSupabase({});
  assert.deepEqual(await revertOrdersIfNoLongerComplete(sb, []), []);
});
