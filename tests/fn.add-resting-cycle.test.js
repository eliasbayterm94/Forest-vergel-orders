'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const { loadHandler, setFake, postEvent, parseRes } = require('./helpers/fn-harness');

const LOT = 'aaaaaaaa-0000-0000-0000-000000000001';

function fixture(lot = {}, cycles = []) {
  return createFakeSupabase({
    production_lots: [{
      id: LOT, status: 'Ready', bache_code: '29-1000', lot_code: 'LOT-1',
      drying_start_date: '2026-06-05', ready_date: '2026-06-30', notes: null,
      ...lot,
    }],
    lot_resting_cycles: cycles,
  });
}

const handler = loadHandler('lot-add-resting-cycle', fixture());

const VALID = {
  lot_id: LOT,
  start_date: '2026-06-12', start_humidity: 19,
  end_date: '2026-06-18', end_humidity: 14,
  end_reason: 'to_ready',
  reason: 'Se omitió el registro del descanso en su momento',
};

test('validaciones básicas', async () => {
  setFake(fixture());
  let r = parseRes(await handler(postEvent({ ...VALID, lot_id: null }), {}));
  assert.equal(r.body.code, 'LOT_ID_REQUIRED');

  setFake(fixture());
  r = parseRes(await handler(postEvent({ ...VALID, end_date: '2026-06-10' }), {}));
  assert.equal(r.body.code, 'INVALID_RANGE');

  setFake(fixture());
  r = parseRes(await handler(postEvent({ ...VALID, start_humidity: 50 }), {}));
  assert.equal(r.body.code, 'INVALID_HUMIDITY');

  setFake(fixture());
  r = parseRes(await handler(postEvent({ ...VALID, end_reason: 'otra_cosa' }), {}));
  assert.equal(r.body.code, 'INVALID_REASON');

  setFake(fixture());
  r = parseRes(await handler(postEvent({ ...VALID, reason: 'corto' }), {}));
  assert.equal(r.body.code, 'REASON_TOO_SHORT');
});

test('solo baches Ready (Delivered rebota)', async () => {
  setFake(fixture({ status: 'Delivered' }));
  const r = parseRes(await handler(postEvent(VALID), {}));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'INVALID_STATUS');
});

test('happy path: inserta ciclo con cycle_number = max + 1 y audita', async () => {
  const fake = fixture({}, [
    { id: 'c1', production_lot_id: LOT, cycle_number: 1, start_date: '2026-06-08', start_humidity: 20 },
  ]);
  setFake(fake);
  const r = parseRes(await handler(postEvent({ ...VALID, operator_name: 'María R.' }), {}));
  assert.equal(r.status, 200);
  assert.equal(r.body.cycle.cycle_number, 2);
  assert.deepEqual(r.body.warnings, []);

  const inserted = fake._db.lot_resting_cycles.find((c) => c.cycle_number === 2);
  assert.equal(inserted.start_humidity, 19);
  assert.equal(inserted.end_reason, 'to_ready');

  const notes = fake._db.production_lots[0].notes;
  assert.match(notes, /\[Ciclo de descanso agregado retroactivamente · finca \(María R\.\) · \d{4}-\d{2}-\d{2}\]/);
  assert.match(notes, /Ciclo 2: 12\/06\/2026 → 18\/06\/2026 \(19% → 14%, fin=to_ready\)/);
});

test('fechas fuera de la ventana secado→cierre devuelven warnings (no bloquean)', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({
    ...VALID,
    start_date: '2026-06-01',   // antes del drying_start (06-05)
    end_date: '2026-07-05',     // después del ready (06-30)
  }), {}));
  assert.equal(r.status, 200);
  assert.equal(r.body.warnings.length, 2);
});
