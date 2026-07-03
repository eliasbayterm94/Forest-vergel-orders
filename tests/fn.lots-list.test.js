'use strict';

// Caracterización del inventario que expone production-lots-list.
// Este test FIJA el comportamiento actual antes del refactor a
// _lib/lotInventory.js: si el refactor cambia un solo número, esto
// truena. Fixture rico: mezclas + parcial despachado + whole/by-kg
// + asignaciones + compras.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const { loadHandler, setFake, postEvent, parseRes } = require('./helpers/fn-harness');

const LOT = 'aaaaaaaa-0000-0000-0000-000000000001';
const SHIP_W = 'cccccccc-0000-0000-0000-000000000001';
const SHIP_P = 'cccccccc-0000-0000-0000-000000000002';

function richFixture() {
  return createFakeSupabase({
    production_lots: [{
      id: LOT, lot_code: 'LOT-1', bache_code: '29-1000', blend_code: null, is_blend: false,
      parent_lot_id: null, sub_bache_number: null,
      reference_id: null, process_type: 'Lavado', processing_stage: 'cereza',
      kg_cherry_input: 4500, kg_despulpado_input: null,
      kg_green_expected: 588, kg_green_actual: 700,
      kg_dried_output: 1000, factor_rendimiento: 100,
      status: 'Ready', fermentation_hours: 48,
      start_date: '2026-06-01', drying_start_date: '2026-06-03',
      ready_date: '2026-06-20', delivered_date: null,
      drying_locations: ['Patio'],
      resting_start_date: null, resting_humidity: null,
      kg_input_initial: 4500, conversion_factor: 4.5,
      final_humidity: 11, fermentation_tanks: [], fermentation_types: [],
      fermentation_start_at: null, drying_start_at: null,
      notes: null, created_by: 'finca', created_at: '2026-06-01', updated_at: '2026-06-20',
      infusion_id: null, infusion_pct: null,
      lot_resting_cycles: [],
      coffee_references: { id: 'r1', name: 'Café X' },
      infusions: null,
      production_lot_varieties: [{ coffee_varieties: { id: 'v1', name: 'Caturra' } }],
      lot_partials: [
        // Parcial A: despachado (150 kg)
        { id: 'pA', parcial_letter: 'A', kg_dried: 150, factor_rendimiento: 100,
          kg_green_yield: 105, completed_at: '2026-06-21', notes: null, created_at: '2026-06-21',
          rejected_at: null, rejection_reason: null,
          shipment_lots: [{ shipment_id: SHIP_P, shipments: { shipment_code: 'DSP-P', shipment_date: '2026-06-22' } }] },
        // Parcial B: sin despachar (50 kg) — NO descuenta
        { id: 'pB', parcial_letter: 'B', kg_dried: 50, factor_rendimiento: 100,
          kg_green_yield: 35, completed_at: '2026-06-23', notes: null, created_at: '2026-06-23',
          rejected_at: null, rejection_reason: null,
          shipment_lots: [] },
      ],
      lot_order_assignments: [
        { id: 'a1', demand_order_id: 'o1', kg_green_allocated: 300,
          demand_orders: { id: 'o1', order_code: 'PED-1', status: 'InProduction', max_delivery_date: '2026-07-01' } },
      ],
      lot_blend_components: [{ kg_dried_used: 100 }],   // como fuente de una mezcla
      lot_purchases: [
        { id: 'pu1', client_name: 'Cliente Directo', kg_green_allocated: 50, notes: null, created_at: '2026-06-22' },
      ],
    }],
    // Tabla física de shipment_lots: el whole/by-kg (lot_partial_id null)
    // y el link del parcial (lot_partial_id pA — excluido por .is(null))
    shipment_lots: [
      { production_lot_id: LOT, lot_partial_id: null, kg_dried_shipped: 200,
        shipment_id: SHIP_W, shipments: { shipment_code: 'DSP-W', shipment_date: '2026-06-25' } },
      { production_lot_id: LOT, lot_partial_id: 'pA', kg_dried_shipped: null,
        shipment_id: SHIP_P, shipments: { shipment_code: 'DSP-P', shipment_date: '2026-06-22' } },
    ],
    lot_blend_components: [],   // segunda query solo para is_blend=true — no aplica
  });
}

const handler = loadHandler('production-lots-list', richFixture());

test('caracterización: ledger de seco (total 1000 − mezcla 100 − parcial 150 − whole 200)', async () => {
  setFake(richFixture());
  const r = parseRes(await handler(postEvent(null, { method: 'GET' }), {}));
  assert.equal(r.status, 200);
  const lot = r.body.lots[0];

  assert.equal(lot.kg_dried_used_in_blends, 100);
  assert.equal(lot.kg_dried_shipped, 350);        // 150 parcial + 200 whole
  assert.equal(lot.kg_dried_available, 550);      // 1000 − 100 − 150 − 200
});

test('caracterización: ledger de verde (ratio 0.7)', async () => {
  setFake(richFixture());
  const r = parseRes(await handler(postEvent(null, { method: 'GET' }), {}));
  const lot = r.body.lots[0];

  // greenPerDried = 700/1000 = 0.7 · greenGone = 450 × 0.7 = 315
  assert.equal(lot.kg_green_assigned_orders, 300);
  assert.equal(lot.kg_green_assigned_purchases, 50);
  assert.equal(lot.kg_green_assigned, 350);
  assert.equal(lot.kg_green_available, 35);       // 700 − 315 − 350
});

test('caracterización: shipments[] combina whole y partial, más reciente primero', async () => {
  setFake(richFixture());
  const r = parseRes(await handler(postEvent(null, { method: 'GET' }), {}));
  const lot = r.body.lots[0];

  assert.equal(lot.shipments.length, 2);
  assert.equal(lot.shipments[0].shipment_code, 'DSP-W');   // 06-25 primero
  assert.equal(lot.shipments[0].via, 'whole');
  assert.equal(lot.shipments[0].kg_dried, 200);
  assert.equal(lot.shipments[1].shipment_code, 'DSP-P');
  assert.equal(lot.shipments[1].via, 'partial');
  assert.equal(lot.shipments[1].kg_dried, 150);
  assert.equal(lot.shipments[1].parcial_letter, 'A');
});

test('caracterización: partials mapeados con su shipment y orden alfabético', async () => {
  setFake(richFixture());
  const r = parseRes(await handler(postEvent(null, { method: 'GET' }), {}));
  const lot = r.body.lots[0];

  assert.equal(lot.partials.length, 2);
  assert.equal(lot.partials[0].parcial_letter, 'A');
  assert.equal(lot.partials[0].shipment_code, 'DSP-P');
  assert.equal(lot.partials[1].parcial_letter, 'B');
  assert.equal(lot.partials[1].shipment_code, null);
});

test('caracterización: lote limpio sin movimientos', async () => {
  const fake = createFakeSupabase({
    production_lots: [{
      id: LOT, lot_code: 'LOT-2', bache_code: '29-2000', is_blend: false,
      kg_green_expected: 207, kg_green_actual: null, kg_dried_output: null,
      status: 'InFermentation', start_date: '2026-06-10',
      lot_resting_cycles: [], coffee_references: null, infusions: null,
      production_lot_varieties: [], lot_partials: [],
      lot_order_assignments: [], lot_blend_components: [], lot_purchases: [],
    }],
    shipment_lots: [],
    lot_blend_components: [],
  });
  setFake(fake);
  const r = parseRes(await handler(postEvent(null, { method: 'GET' }), {}));
  const lot = r.body.lots[0];

  assert.equal(lot.kg_dried_shipped, 0);
  assert.equal(lot.kg_dried_available, 0);        // sin dried output
  assert.equal(lot.kg_green_available, 207);      // expected íntegro
  assert.deepEqual(lot.shipments, []);
});
