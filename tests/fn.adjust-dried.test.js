'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const { loadHandler, setFake, postEvent, parseRes } = require('./helpers/fn-harness');

const LOT = 'aaaaaaaa-0000-0000-0000-000000000001';

function fixture(overrides = {}) {
  return createFakeSupabase({
    production_lots: [{
      id: LOT, status: 'Delivered', delivered_date: '2026-06-01',
      bache_code: '29-1000', lot_code: 'LOT-1',
      kg_input_initial: 1586,          // conversión con 350 seco ≈ 4.53 (dentro de banda cereza)
      kg_dried_output: 350, kg_green_actual: 245,
      factor_rendimiento: 100, conversion_factor: 4.53,
      processing_stage: 'cereza', notes: null,
      lot_partials: [],
      ...(overrides.lot || {}),
    }],
    lot_blend_components: overrides.lot_blend_components || [],
    shipment_lots: overrides.shipment_lots || [
      { production_lot_id: LOT, kg_dried_shipped: 200, lot_partial_id: null },
    ],
    lot_order_assignments: overrides.lot_order_assignments || [],
    demand_orders: overrides.demand_orders || [],
  });
}

const handler = loadHandler('production-lots-adjust-dried', fixture());

test('valida lot_id requerido', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({ kg_dried_output: 400, reason: 'motivo suficientemente largo' }), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'LOT_ID_REQUIRED');
});

test('valida kg > 0', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({ lot_id: LOT, kg_dried_output: -5, reason: 'motivo suficientemente largo' }), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_DRIED');
});

test('motivo < 10 chars rebota', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({ lot_id: LOT, kg_dried_output: 400, reason: 'corto' }), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'REASON_TOO_SHORT');
});

test('status Drying rebota (solo Ready/Delivered)', async () => {
  setFake(fixture({ lot: { status: 'Drying' } }));
  const r = parseRes(await handler(postEvent({ lot_id: LOT, kg_dried_output: 400, reason: 'motivo suficientemente largo' }), {}));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'INVALID_STATUS');
});

test('nuevo valor menor que lo ya salido rebota NEW_LESS_THAN_OUT', async () => {
  setFake(fixture());   // 200 kg ya despachados
  const r = parseRes(await handler(postEvent({ lot_id: LOT, kg_dried_output: 150, reason: 'motivo suficientemente largo' }), {}));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'NEW_LESS_THAN_OUT');
  assert.equal(r.body.already_out_kg, 200);
});

test('peso físicamente imposible rebota IMPLAUSIBLE_WEIGHT (sin override posible)', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({
    lot_id: LOT, kg_dried_output: 2000, reason: 'motivo suficientemente largo',
    override_plausibility: true,   // ni con override pasa el HARD
  }), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'IMPLAUSIBLE_WEIGHT');
});

test('conversión fuera de banda pide confirmación; con override pasa', async () => {
  // 1586 / 900 ≈ 1.76 → fuera de banda cereza (2–6)
  setFake(fixture());
  const r1 = parseRes(await handler(postEvent({
    lot_id: LOT, kg_dried_output: 900, reason: 'motivo suficientemente largo',
  }), {}));
  assert.equal(r1.status, 409);
  assert.equal(r1.body.code, 'PLAUSIBILITY_CONFIRM_REQUIRED');

  setFake(fixture());
  const r2 = parseRes(await handler(postEvent({
    lot_id: LOT, kg_dried_output: 900, reason: 'motivo suficientemente largo',
    override_plausibility: true,
  }), {}));
  assert.equal(r2.status, 200);
});

test('happy path: ajuste hacia arriba revierte Delivered → Ready con saldo', async () => {
  const fake = fixture();
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    lot_id: LOT, kg_dried_output: 400,
    reason: 'Había 50 kg más en bodega sin pesar',
    operator_name: 'Juan Pérez',
  }), {}));
  assert.equal(r.status, 200);
  assert.equal(r.body.reverted_to_ready, true);
  assert.equal(r.body.new_available_kg, 200);   // 400 - 200 despachados

  const lot = fake._db.production_lots[0];
  assert.equal(lot.status, 'Ready');
  assert.equal(lot.delivered_date, null);
  assert.equal(lot.kg_dried_output, 400);
  // Verde escalado proporcionalmente: 245 × (400/350) = 280
  assert.equal(lot.kg_green_actual, 280);
  // Conversión recalculada: 1586 / 400 = 3.965
  assert.equal(lot.conversion_factor, 3.965);
  // Auditoría con operario
  assert.match(lot.notes, /\[Ajuste seco · finca \(Juan Pérez\) · \d{4}-\d{2}-\d{2}\] 350 kg → 400 kg/);
});

test('ajuste que NO deja saldo mantiene Delivered', async () => {
  // Despachados 350 (todo). Ajuste a 350 exacto — nada que revertir.
  const fake = fixture({
    shipment_lots: [{ production_lot_id: LOT, kg_dried_shipped: 350, lot_partial_id: null }],
  });
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    lot_id: LOT, kg_dried_output: 350, reason: 'confirmando pesos tras inventario',
  }), {}));
  assert.equal(r.status, 200);
  assert.equal(r.body.reverted_to_ready, false);
  assert.equal(fake._db.production_lots[0].status, 'Delivered');
});
