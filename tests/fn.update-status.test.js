'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const { loadHandler, setFake, postEvent, parseRes } = require('./helpers/fn-harness');

const LOT = 'aaaaaaaa-0000-0000-0000-000000000001';

function fixture(lot = {}, extra = {}) {
  return createFakeSupabase({
    production_lots: [{
      id: LOT, status: 'InFermentation',
      bache_code: '29-1000', lot_code: 'LOT-1',
      kg_input_initial: 1586, kg_dried_output: null,
      kg_green_actual: null, kg_green_expected: 207,
      factor_rendimiento: null, conversion_factor: null,
      processing_stage: 'cereza', process_type: 'Lavado',
      drying_start_date: null, drying_start_at: null, drying_locations: [],
      resting_start_date: null, resting_humidity: null,
      ready_date: null, delivered_date: null,
      ...lot,
    }],
    drying_types: [
      { name: 'Patio', active: true },
      { name: 'Silos', active: true },
      { name: 'Mecánico', active: false },   // inactivo — debe rebotar
    ],
    lot_resting_cycles: extra.lot_resting_cycles || [],
    lot_partials: extra.lot_partials || [],
    lot_order_assignments: extra.lot_order_assignments || [],
    demand_orders: extra.demand_orders || [],
  });
}

const handler = loadHandler('production-lots-update-status', fixture());

test('transición inválida rebota (InFermentation → Ready)', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({ lot_id: LOT, status: 'Ready' }), {}));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'INVALID_TRANSITION');
});

test('drying_locations con tipo inactivo rebota', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({
    lot_id: LOT, status: 'Drying',
    drying_start_date: '2026-06-10', drying_locations: ['Mecánico'],
  }), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_LOCATIONS');
});

test('primera entrada a Drying setea fecha + locations en el lot', async () => {
  const fake = fixture();
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    lot_id: LOT, status: 'Drying',
    drying_start_date: '2026-06-10', drying_locations: ['Patio'],
  }), {}));
  assert.equal(r.status, 200);
  const lot = fake._db.production_lots[0];
  assert.equal(lot.status, 'Drying');
  assert.equal(lot.drying_start_date, '2026-06-10');
  assert.deepEqual(lot.drying_locations, ['Patio']);
});

test('Resting sin humedad rebota', async () => {
  setFake(fixture({ status: 'Drying', drying_start_date: '2026-06-10' }));
  const r = parseRes(await handler(postEvent({
    lot_id: LOT, status: 'Resting', resting_start_date: '2026-06-15',
  }), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'HUMIDITY_REQUIRED');
});

test('Drying → Resting abre ciclo con humedad', async () => {
  const fake = fixture({ status: 'Drying', drying_start_date: '2026-06-10' });
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    lot_id: LOT, status: 'Resting',
    resting_start_date: '2026-06-15', resting_humidity: 18.5,
  }), {}));
  assert.equal(r.status, 200);
  assert.equal(fake._db.lot_resting_cycles.length, 1);
  assert.equal(fake._db.lot_resting_cycles[0].cycle_number, 1);
  assert.equal(fake._db.lot_resting_cycles[0].start_humidity, 18.5);
});

test('salir de Resting sin exit humidity rebota', async () => {
  setFake(fixture(
    { status: 'Resting', drying_start_date: '2026-06-10', resting_start_date: '2026-06-15', resting_humidity: 18.5 },
    { lot_resting_cycles: [{ id: 'c1', production_lot_id: LOT, cycle_number: 1, start_date: '2026-06-15', start_humidity: 18.5, end_date: null }] },
  ));
  const r = parseRes(await handler(postEvent({ lot_id: LOT, status: 'Drying' }), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'EXIT_HUMIDITY_REQUIRED');
});

test('Resting → Drying: locations van al CICLO, no al lot (bug de sobreescritura)', async () => {
  const fake = fixture(
    { status: 'Resting', drying_start_date: '2026-06-10', drying_locations: ['Patio'],
      resting_start_date: '2026-06-15', resting_humidity: 18.5 },
    { lot_resting_cycles: [{ id: 'c1', production_lot_id: LOT, cycle_number: 1, start_date: '2026-06-15', start_humidity: 18.5, end_date: null }] },
  );
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    lot_id: LOT, status: 'Drying',
    resting_exit_humidity: 14,
    drying_start_date: '2026-06-20',
    drying_locations: ['Silos'],
  }), {}));
  assert.equal(r.status, 200);
  const lot = fake._db.production_lots[0];
  // El secado INICIAL se preserva
  assert.deepEqual(lot.drying_locations, ['Patio']);
  assert.equal(lot.drying_start_date, '2026-06-10');
  // El ciclo se cerró con las locations del NUEVO secado
  const cycle = fake._db.lot_resting_cycles[0];
  assert.equal(cycle.end_reason, 'back_to_drying');
  assert.equal(cycle.end_date, '2026-06-20');
  assert.deepEqual(cycle.drying_locations_after, ['Silos']);
});

test('cierre a Ready: plausibility CONFIRM sin override, pasa con override', async () => {
  // 1586 / 900 ≈ 1.76 → fuera de banda cereza (2–6)
  const lotDrying = { status: 'Drying', drying_start_date: '2026-06-10' };
  setFake(fixture(lotDrying));
  const r1 = parseRes(await handler(postEvent({
    lot_id: LOT, status: 'Ready',
    kg_dried_output: 900, factor_rendimiento: 100,
  }), {}));
  assert.equal(r1.status, 409);
  assert.equal(r1.body.code, 'PLAUSIBILITY_CONFIRM_REQUIRED');

  const fake = fixture(lotDrying);
  setFake(fake);
  const r2 = parseRes(await handler(postEvent({
    lot_id: LOT, status: 'Ready',
    kg_dried_output: 900, factor_rendimiento: 100,
    override_plausibility: true,
  }), {}));
  assert.equal(r2.status, 200);
  assert.equal(fake._db.production_lots[0].status, 'Ready');
});

test('cierre a Ready normal: calcula conversión y verde por factor', async () => {
  const fake = fixture({ status: 'Drying', drying_start_date: '2026-06-10' });
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    lot_id: LOT, status: 'Ready',
    kg_dried_output: 350, factor_rendimiento: 100,
    ready_date: '2026-06-25', final_humidity: 11,
  }), {}));
  assert.equal(r.status, 200);
  const lot = fake._db.production_lots[0];
  assert.equal(lot.status, 'Ready');
  assert.equal(lot.kg_dried_output, 350);
  // verde = (350 / 100) × 70 = 245
  assert.equal(lot.kg_green_actual, 245);
  // conversión = 1586 / 350 = 4.5314
  assert.equal(lot.conversion_factor, 4.5314);
  assert.equal(lot.final_humidity, 11);
});

test('peso imposible rebota IMPLAUSIBLE_WEIGHT al cerrar', async () => {
  setFake(fixture({ status: 'Drying', drying_start_date: '2026-06-10' }));
  const r = parseRes(await handler(postEvent({
    lot_id: LOT, status: 'Ready',
    kg_dried_output: 5000, factor_rendimiento: 100,
    override_plausibility: true,   // HARD no se puede overridear
  }), {}));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'IMPLAUSIBLE_WEIGHT');
});
