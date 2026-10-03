'use strict';

// Prefermentación y el invariante de "Secado directo" a nivel de
// endpoint: production-lots-update y el guard del tipo administrado
// por el sistema en fermentation-types-update.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const { loadHandler, setFake, postEvent, parseRes } = require('./helpers/fn-harness');

const LOT = 'aaaaaaaa-0000-0000-0000-000000000001';
const SD = 'Secado directo';

function fixture(lot = {}) {
  return createFakeSupabase({
    production_lots: [{
      id: LOT, bache_code: '29-1000', lot_code: 'LOT-1', status: 'InFermentation',
      is_blend: false, processing_stage: 'cereza',
      kg_input_initial: 1586, kg_dried_output: null,
      kg_green_actual: null, kg_green_expected: 207,
      kg_cherry_input: 1586, kg_despulpado_input: null,
      fermentation_hours: 48, fermentation_types: ['Láctica'],
      prefermentation_hours: null,
      ...lot,
    }],
    fermentation_types: [
      { id: 'ft1', name: 'Láctica',    kind: null, active: true },
      { id: 'ft2', name: 'Anaeróbico', kind: null, active: true },
      { id: 'ft3', name: SD,          kind: null, active: true },
    ],
  });
}

const updateH = loadHandler('production-lots-update', fixture());
const typesUpdateH = loadHandler('fermentation-types-update');

const asFinca = (body) => postEvent(body, { role: 'finca' });
const asAdmin = (body) => postEvent(body, { role: 'admin' });

// ── prefermentación ───────────────────────────────────────────────

test('guarda las horas de prefermentación en el bache', async () => {
  const fake = fixture();
  setFake(fake);

  const res = parseRes(await updateH(asFinca({
    lot_id: LOT, fields: { prefermentation_hours: 18 },
  })));

  assert.equal(res.status, 200);
  assert.equal(fake._db.production_lots[0].prefermentation_hours, 18);
});

test('prefermentación 0 se guarda como 0, no como null', async () => {
  // 0 = "no hubo prefermentación"; null = "no se registró".
  const fake = fixture({ prefermentation_hours: 24 });
  setFake(fake);

  const res = parseRes(await updateH(asFinca({
    lot_id: LOT, fields: { prefermentation_hours: 0 },
  })));

  assert.equal(res.status, 200);
  assert.equal(fake._db.production_lots[0].prefermentation_hours, 0);
});

test('prefermentación vacía limpia el valor a null', async () => {
  const fake = fixture({ prefermentation_hours: 24 });
  setFake(fake);

  const res = parseRes(await updateH(asFinca({
    lot_id: LOT, fields: { prefermentation_hours: null },
  })));

  assert.equal(res.status, 200);
  assert.equal(fake._db.production_lots[0].prefermentation_hours, null);
});

test('prefermentación negativa → 400 y no toca la fila', async () => {
  const fake = fixture({ prefermentation_hours: 24 });
  setFake(fake);

  const res = parseRes(await updateH(asFinca({
    lot_id: LOT, fields: { prefermentation_hours: -5 },
  })));

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_PREFERM_HOURS');
  assert.equal(fake._db.production_lots[0].prefermentation_hours, 24);
});

test('la prefermentación no altera el estado del bache', async () => {
  // Es un parámetro descriptivo: no mueve el flujo ni las fechas.
  const fake = fixture();
  setFake(fake);

  await updateH(asFinca({ lot_id: LOT, fields: { prefermentation_hours: 12 } }));

  const row = fake._db.production_lots[0];
  assert.equal(row.status, 'InFermentation');
  assert.equal(row.fermentation_hours, 48);
});

// ── invariante "Secado directo" en el endpoint ────────────────────

test('poner 0 horas de fermentación marca "Secado directo" solo', async () => {
  const fake = fixture();
  setFake(fake);

  const res = parseRes(await updateH(asFinca({
    lot_id: LOT, fields: { fermentation_hours: 0 },
  })));

  assert.equal(res.status, 200);
  assert.ok(fake._db.production_lots[0].fermentation_types.includes(SD));
  // Conserva el tipo que ya tenía.
  assert.ok(fake._db.production_lots[0].fermentation_types.includes('Láctica'));
});

test('pedir "Secado directo" con horas > 0 → 400 y no escribe nada', async () => {
  const fake = fixture();
  setFake(fake);

  const res = parseRes(await updateH(asFinca({
    lot_id: LOT, fields: { fermentation_types: ['Láctica', SD], fermentation_hours: 36 },
  })));

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'FERM_TYPE_HOURS_MISMATCH');
  assert.deepEqual(fake._db.production_lots[0].fermentation_types, ['Láctica']);
  assert.equal(fake._db.production_lots[0].fermentation_hours, 48);
});

test('subir las horas de 0 a reales quita el rótulo heredado', async () => {
  const fake = fixture({ fermentation_hours: 0, fermentation_types: ['Láctica', SD] });
  setFake(fake);

  const res = parseRes(await updateH(asFinca({
    lot_id: LOT, fields: { fermentation_hours: 60 },
  })));

  assert.equal(res.status, 200);
  assert.deepEqual(fake._db.production_lots[0].fermentation_types, ['Láctica']);
  assert.equal(fake._db.production_lots[0].fermentation_hours, 60);
});

test('una edición que no toca fermentación no reescribe los tipos', async () => {
  // El bache está incoherente de antes (dato histórico). Editar las
  // notas no debe disparar una normalización silenciosa.
  const fake = fixture({ fermentation_hours: 48, fermentation_types: ['Láctica', SD] });
  setFake(fake);

  const res = parseRes(await updateH(asFinca({
    lot_id: LOT, fields: { notes: 'otra cosa' },
  })));

  assert.equal(res.status, 200);
  assert.deepEqual(fake._db.production_lots[0].fermentation_types, ['Láctica', SD]);
});

test('al marcarse solo, el rótulo se guarda con la grafía canónica', async () => {
  const fake = fixture({ fermentation_hours: 48, fermentation_types: ['Láctica'] });
  setFake(fake);

  const res = parseRes(await updateH(asFinca({
    lot_id: LOT, fields: { fermentation_hours: 0 },
  })));

  assert.equal(res.status, 200);
  const types = fake._db.production_lots[0].fermentation_types;
  assert.ok(types.includes(SD));
  // Exactamente una vez, y con la grafía exacta de la tabla.
  assert.equal(types.filter((t) => t.toLowerCase() === SD.toLowerCase()).length, 1);
});

// La insensibilidad a mayúsculas que viene de citext no se puede
// ejercitar acá: el fake de Supabase compara `name` exacto en .in(),
// mientras la columna real es citext. Esa cobertura vive en
// tests/fermentationTypes.test.js, contra el helper directamente.

// ── guard del tipo administrado por el sistema ────────────────────

test('no se puede desactivar "Secado directo" desde /admin/config', async () => {
  const fake = fixture();
  setFake(fake);

  const res = parseRes(await typesUpdateH(asAdmin({
    id: 'ft3', fields: { active: false },
  })));

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'SYSTEM_FERM_TYPE');
  assert.equal(fake._db.fermentation_types.find((t) => t.id === 'ft3').active, true);
});

test('no se puede renombrar "Secado directo"', async () => {
  const fake = fixture();
  setFake(fake);

  const res = parseRes(await typesUpdateH(asAdmin({
    id: 'ft3', fields: { name: 'Secado al sol' },
  })));

  assert.equal(res.status, 409);
  assert.equal(fake._db.fermentation_types.find((t) => t.id === 'ft3').name, SD);
});

test('"Secado directo" sí se puede reclasificar (kind)', async () => {
  const fake = fixture();
  setFake(fake);

  const res = parseRes(await typesUpdateH(asAdmin({
    id: 'ft3', fields: { kind: 'Sin fermentación' },
  })));

  assert.equal(res.status, 200);
  assert.equal(fake._db.fermentation_types.find((t) => t.id === 'ft3').kind, 'Sin fermentación');
});

test('los otros tipos se siguen pudiendo desactivar y renombrar', async () => {
  const fake = fixture();
  setFake(fake);

  assert.equal(parseRes(await typesUpdateH(asAdmin({
    id: 'ft1', fields: { active: false },
  }))).status, 200);

  assert.equal(parseRes(await typesUpdateH(asAdmin({
    id: 'ft2', fields: { name: 'Anaeróbico controlado' },
  }))).status, 200);
});
