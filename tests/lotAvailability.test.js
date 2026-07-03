'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const { computeGreenAvailability } = require('../netlify/functions/_lib/lotAvailability');

const LOT = '11111111-1111-1111-1111-111111111111';

function baseTables(overrides = {}) {
  return {
    production_lots: [{ id: LOT, kg_green_actual: 700, kg_green_expected: 650, kg_dried_output: 1000 }],
    lot_order_assignments: [],
    lot_purchases: [],
    lot_blend_components: [],
    shipment_lots: [],
    ...overrides,
  };
}

test('lote limpio: disponible = verde total', async () => {
  const sb = createFakeSupabase(baseTables());
  const r = await computeGreenAvailability(sb, LOT);
  assert.equal(r.totalGreen, 700);
  assert.equal(r.available, 700);
  assert.equal(r.greenGone, 0);
});

test('asignaciones y compras descuentan del disponible', async () => {
  const sb = createFakeSupabase(baseTables({
    lot_order_assignments: [
      { production_lot_id: LOT, kg_green_allocated: 300 },
      { production_lot_id: LOT, kg_green_allocated: 250 },
    ],
    lot_purchases: [{ production_lot_id: LOT, kg_green_allocated: 100 }],
  }));
  const r = await computeGreenAvailability(sb, LOT);
  assert.equal(r.assignedOrders, 550);
  assert.equal(r.assignedPurchases, 100);
  assert.equal(r.available, 50);   // 700 - 550 - 100
});

test('despacho parcial por kg (lot_partial_id null) descuenta verde prorrateado', async () => {
  // 1000 kg seco → 700 verde ⇒ ratio 0.7. Despachados 200 kg seco = 140 verde.
  const sb = createFakeSupabase(baseTables({
    shipment_lots: [{ production_lot_id: LOT, kg_dried_shipped: 200, lot_partial_id: null }],
  }));
  const r = await computeGreenAvailability(sb, LOT);
  assert.equal(r.greenGone, 140);
  assert.equal(r.available, 560);
});

test('despacho vía partial usa el kg_dried del partial embebido', async () => {
  const sb = createFakeSupabase(baseTables({
    shipment_lots: [{
      production_lot_id: LOT,
      kg_dried_shipped: null,
      lot_partial_id: 'p1',
      lot_partials: { kg_dried: 500 },
    }],
  }));
  const r = await computeGreenAvailability(sb, LOT);
  assert.equal(r.greenGone, 350);   // 500 × 0.7
  assert.equal(r.available, 350);
});

test('kg en mezclas descuenta con el mismo ratio', async () => {
  const sb = createFakeSupabase(baseTables({
    lot_blend_components: [{ source_lot_id: LOT, kg_dried_used: 300 }],
  }));
  const r = await computeGreenAvailability(sb, LOT);
  assert.equal(r.greenGone, 210);   // 300 × 0.7
  assert.equal(r.available, 490);
});

test('sobre-compromiso clampa el disponible a 0 (nunca negativo)', async () => {
  const sb = createFakeSupabase(baseTables({
    lot_order_assignments: [{ production_lot_id: LOT, kg_green_allocated: 900 }],
  }));
  const r = await computeGreenAvailability(sb, LOT);
  assert.equal(r.available, 0);
});

test('sin kg_green_actual cae a kg_green_expected', async () => {
  const sb = createFakeSupabase({
    production_lots: [{ id: LOT, kg_green_actual: null, kg_green_expected: 650, kg_dried_output: 1000 }],
    lot_order_assignments: [], lot_purchases: [], lot_blend_components: [], shipment_lots: [],
  });
  const r = await computeGreenAvailability(sb, LOT);
  assert.equal(r.totalGreen, 650);
});

test('lote inexistente lanza', async () => {
  const sb = createFakeSupabase(baseTables());
  await assert.rejects(() => computeGreenAvailability(sb, 'no-existe'), /Lot not found/);
});
