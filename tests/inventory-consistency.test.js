'use strict';

// Consistencia cruzada del inventario: el MISMO estado de BD debe
// producir los MISMOS números sin importar qué consumidor pregunte.
// La divergencia entre production-lots-list y lotAvailability fue la
// causa raíz del bug "despaché 200 de 350 y Punto Final seguía
// mostrando 350". Este test la vigila para siempre.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const { loadHandler, setFake, postEvent, parseRes } = require('./helpers/fn-harness');
const { computeGreenAvailability } = require('../netlify/functions/_lib/lotAvailability');

const LOT = 'aaaaaaaa-0000-0000-0000-000000000001';

// Estado con TODOS los tipos de movimiento: mezcla + despacho por
// parcial + despacho whole/by-kg + asignaciones + compras.
function makeFixture() {
  return createFakeSupabase({
    production_lots: [{
      id: LOT, lot_code: 'LOT-1', bache_code: '29-1000', is_blend: false,
      kg_green_expected: 588, kg_green_actual: 700,
      kg_dried_output: 1000, status: 'Ready', start_date: '2026-06-01',
      lot_resting_cycles: [], coffee_references: null, infusions: null,
      production_lot_varieties: [],
      lot_partials: [
        { id: 'pA', parcial_letter: 'A', kg_dried: 150, factor_rendimiento: 100,
          kg_green_yield: 105, rejected_at: null,
          shipment_lots: [{ shipment_id: 's2', shipments: { shipment_code: 'DSP-P', shipment_date: '2026-06-22' } }] },
      ],
      lot_order_assignments: [
        { id: 'a1', demand_order_id: 'o1', kg_green_allocated: 300, demand_orders: null },
      ],
      lot_blend_components: [{ kg_dried_used: 100 }],
      lot_purchases: [
        { id: 'pu1', client_name: 'Cliente', kg_green_allocated: 50, notes: null, created_at: null },
      ],
    }],
    // Tabla física (para lotAvailability y la 2ª query de lots-list):
    // ambas vías de despacho.
    shipment_lots: [
      { production_lot_id: LOT, lot_partial_id: null, kg_dried_shipped: 200,
        shipment_id: 's1', shipments: { shipment_code: 'DSP-W', shipment_date: '2026-06-25' } },
      { production_lot_id: LOT, lot_partial_id: 'pA', kg_dried_shipped: null,
        lot_partials: { kg_dried: 150 },
        shipment_id: 's2', shipments: { shipment_code: 'DSP-P', shipment_date: '2026-06-22' } },
    ],
    lot_blend_components: [
      // Para lotAvailability (query por source_lot_id contra la tabla)
      { source_lot_id: LOT, kg_dried_used: 100 },
    ],
    lot_order_assignments: [
      { production_lot_id: LOT, kg_green_allocated: 300 },
    ],
    lot_purchases: [
      { production_lot_id: LOT, kg_green_allocated: 50 },
    ],
  });
}

const listHandler = loadHandler('production-lots-list', makeFixture());

test('production-lots-list y computeGreenAvailability coinciden en el verde disponible', async () => {
  // Vía 1: el endpoint de lista
  setFake(makeFixture());
  const r = parseRes(await listHandler(postEvent(null, { method: 'GET' }), {}));
  const lot = r.body.lots[0];

  // Vía 2: el helper single-lot (lo usan punto-final vía _assign-modal
  // y otros endpoints)
  const avail = await computeGreenAvailability(makeFixture(), LOT);

  assert.equal(lot.kg_green_available, avail.available,
    'kg verde disponible debe ser idéntico en ambos consumidores');
  assert.equal(lot.kg_green_assigned, avail.assignedOrders + avail.assignedPurchases);
  // Valores absolutos esperados (documentación del fixture):
  //   out seco = 100 mezcla + 150 parcial + 200 whole = 450
  //   greenGone = 450 × 0.7 = 315 · assigned = 350
  //   available = 700 − 315 − 350 = 35
  assert.equal(avail.available, 35);
  assert.equal(lot.kg_green_available, 35);
});

test('el seco disponible del list coincide con el ledger implícito del availability', async () => {
  setFake(makeFixture());
  const r = parseRes(await listHandler(postEvent(null, { method: 'GET' }), {}));
  const lot = r.body.lots[0];

  // dried out = 450 ⇒ available = 550. greenGone/0.7 devuelve el
  // mismo "out" que usó lotAvailability — misma base en ambos lados.
  const avail = await computeGreenAvailability(makeFixture(), LOT);
  const driedOutFromAvailability = avail.greenGone / 0.7;

  assert.equal(lot.kg_dried_available, 550);
  assert.equal(Math.round(driedOutFromAvailability), 1000 - 550);
});
