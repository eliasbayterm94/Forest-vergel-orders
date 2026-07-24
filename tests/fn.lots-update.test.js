'use strict';

// production-lots-update: comportamiento del plausibility al editar
// kg desde el historial, y la excepción para mezclas (input = seco
// por construcción, sin regla de "pierde peso al secar").

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const { loadHandler, setFake, postEvent, parseRes } = require('./helpers/fn-harness');

const LOT = 'aaaaaaaa-0000-0000-0000-000000000001';

function fixture(lot = {}) {
  return createFakeSupabase({
    production_lots: [{
      id: LOT, bache_code: '29-1000', lot_code: 'LOT-1', status: 'Ready',
      is_blend: false, processing_stage: 'cereza',
      kg_input_initial: 1586, kg_dried_output: 350,
      kg_green_actual: 245, kg_green_expected: 207,
      kg_cherry_input: 1586, kg_despulpado_input: null,
      ...lot,
    }],
  });
}

function blendFixture(lot = {}) {
  return fixture({
    is_blend: true, processing_stage: 'seco',
    bache_code: 'MZ-2026-0001', blend_code: 'MZ-2026-0001',
    kg_input_initial: 400, kg_dried_output: 400,
    kg_green_actual: null, kg_green_expected: 250,
    kg_cherry_input: null,
    ...lot,
  });
}

const handler = loadHandler('production-lots-update', fixture());

test('bache normal: kg fuera de banda pide confirmación; con override pasa', async () => {
  // 1586 / 900 ≈ 1.76 → fuera de banda cereza (2–6)
  setFake(fixture());
  const r1 = parseRes(await handler(postEvent({
    lot_id: LOT, fields: { kg_dried_output: 900 },
  }), {}));
  assert.equal(r1.status, 409);
  assert.equal(r1.body.code, 'PLAUSIBILITY_CONFIRM_REQUIRED');

  setFake(fixture());
  const r2 = parseRes(await handler(postEvent({
    lot_id: LOT, fields: { kg_dried_output: 900 }, override_plausibility: true,
  }), {}));
  assert.equal(r2.status, 200);
});

test('mezcla: subir el kg NO dispara plausibility y arrastra input + expected', async () => {
  const fake = blendFixture();
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    lot_id: LOT, fields: { kg_dried_output: 450 },
  }), {}));
  assert.equal(r.status, 200, `esperaba 200: ${JSON.stringify(r.body)}`);

  const lot = fake._db.production_lots[0];
  assert.equal(lot.kg_dried_output, 450);
  assert.equal(lot.kg_input_initial, 450);          // acompaña al seco
  assert.equal(lot.kg_green_expected, 281.25);      // 250 × 450/400 — NO ÷1.34 genérico
});

test('mezcla: kg_green_actual explícito del operario NO se pisa con el escalado', async () => {
  const fake = blendFixture({ kg_green_actual: 260 });
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    lot_id: LOT, fields: { kg_dried_output: 450, kg_green_actual: 300 },
  }), {}));
  assert.equal(r.status, 200);
  assert.equal(fake._db.production_lots[0].kg_green_actual, 300);   // el suyo, no 292.5
});
