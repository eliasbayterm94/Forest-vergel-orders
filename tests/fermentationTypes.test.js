'use strict';

// Invariante de "Secado directo" y validación de prefermentación.
// Ver migración 0049 y _lib/fermentationTypes.js.
//
// El sistema ya modela "sin fermentación" con fermentation_hours = 0
// (el bache nace en Drying). "Secado directo" es el rótulo explícito
// de esa condición, y debe cumplirse:
//
//     "Secado directo" ∈ fermentation_types  ⟺  fermentation_hours = 0

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SECADO_DIRECTO, isSecadoDirecto, hasSecadoDirecto, reconcileSecadoDirecto,
} = require('../netlify/functions/_lib/fermentationTypes');
const { validatePrefermentationHours, MAX_HOURS } =
  require('../netlify/functions/_lib/prefermentation');

// ── isSecadoDirecto ───────────────────────────────────────────────

test('isSecadoDirecto tolera mayúsculas y espacios (la BD es citext)', () => {
  assert.equal(isSecadoDirecto('Secado directo'), true);
  assert.equal(isSecadoDirecto('  secado DIRECTO  '), true);
  assert.equal(isSecadoDirecto('Secado'), false);
  assert.equal(isSecadoDirecto('Anaeróbico'), false);
  assert.equal(isSecadoDirecto(null), false);
  assert.equal(isSecadoDirecto(undefined), false);
});

test('hasSecadoDirecto encuentra el tipo dentro de la lista', () => {
  assert.equal(hasSecadoDirecto(['Láctica', 'secado directo']), true);
  assert.equal(hasSecadoDirecto(['Láctica', 'Anaeróbico']), false);
  assert.equal(hasSecadoDirecto([]), false);
  assert.equal(hasSecadoDirecto(null), false);
});

// ── 0 horas → el tipo se marca solo ───────────────────────────────

test('0 horas marca "Secado directo" automáticamente', () => {
  const r = reconcileSecadoDirecto([], 0);
  assert.equal(r.ok, true);
  assert.deepEqual(r.types, [SECADO_DIRECTO]);
});

test('0 horas conserva los otros tipos y agrega el rótulo', () => {
  const r = reconcileSecadoDirecto(['Láctica'], 0);
  assert.equal(r.ok, true);
  assert.deepEqual(r.types, ['Láctica', SECADO_DIRECTO]);
});

test('0 horas no duplica el tipo si ya venía puesto', () => {
  const r = reconcileSecadoDirecto([SECADO_DIRECTO], 0);
  assert.equal(r.ok, true);
  assert.deepEqual(r.types, [SECADO_DIRECTO]);
});

test('normaliza la grafía del rótulo al nombre canónico', () => {
  // fermentation_types es text[], no citext: si guardáramos la
  // variante tal cual, la hoja del bache mostraría "secado DIRECTO".
  const r = reconcileSecadoDirecto(['secado DIRECTO', 'Láctica'], 0);
  assert.equal(r.ok, true);
  assert.deepEqual(r.types, ['Láctica', SECADO_DIRECTO]);
});

// ── horas > 0 con el tipo puesto ──────────────────────────────────

test('pedir "Secado directo" con horas > 0 es error del usuario', () => {
  const r = reconcileSecadoDirecto([SECADO_DIRECTO], 48, { typesExplicit: true });
  assert.equal(r.ok, false);
  assert.match(r.message, /solo aplica con 0 horas/);
});

test('el tipo heredado de la fila se quita solo al poner horas reales', () => {
  // El usuario editó solo las horas: no tiene sentido devolverle un 400
  // por un tipo que nunca eligió. Se corrige en silencio.
  const r = reconcileSecadoDirecto([SECADO_DIRECTO, 'Láctica'], 48, { typesExplicit: false });
  assert.equal(r.ok, true);
  assert.deepEqual(r.types, ['Láctica']);
});

test('horas > 0 sin el tipo no cambia nada', () => {
  const r = reconcileSecadoDirecto(['Láctica', 'Anaeróbico'], 72);
  assert.equal(r.ok, true);
  assert.deepEqual(r.types, ['Láctica', 'Anaeróbico']);
});

test('el invariante se cumple en ambos sentidos para todo par válido', () => {
  for (const hours of [0, 1, 24, 48]) {
    for (const types of [[], ['Láctica'], [SECADO_DIRECTO], [SECADO_DIRECTO, 'Láctica']]) {
      const r = reconcileSecadoDirecto(types, hours, { typesExplicit: false });
      assert.equal(r.ok, true, `inesperado 400 con ${hours}h y ${JSON.stringify(types)}`);
      assert.equal(
        hasSecadoDirecto(r.types), hours === 0,
        `invariante roto: ${hours}h → ${JSON.stringify(r.types)}`,
      );
    }
  }
});

test('normaliza espacios y descarta entradas vacías', () => {
  const r = reconcileSecadoDirecto(['  Láctica  ', '', '   '], 24);
  assert.equal(r.ok, true);
  assert.deepEqual(r.types, ['Láctica']);
});

// ── prefermentación ───────────────────────────────────────────────

test('prefermentación: vacío y null significan "sin registrar"', () => {
  assert.deepEqual(validatePrefermentationHours(null),      { ok: true, value: null });
  assert.deepEqual(validatePrefermentationHours(undefined), { ok: true, value: null });
  assert.deepEqual(validatePrefermentationHours(''),        { ok: true, value: null });
});

test('prefermentación: 0 es un valor válido y distinto de null', () => {
  // 0 = "no hubo prefermentación"; null = "no se registró".
  assert.deepEqual(validatePrefermentationHours(0),   { ok: true, value: 0 });
  assert.deepEqual(validatePrefermentationHours('0'), { ok: true, value: 0 });
});

test('prefermentación: acepta decimales y strings numéricos', () => {
  assert.deepEqual(validatePrefermentationHours(12.5),   { ok: true, value: 12.5 });
  assert.deepEqual(validatePrefermentationHours('36'),   { ok: true, value: 36 });
});

test('prefermentación: rechaza negativos, no-números y el tope de la columna', () => {
  assert.equal(validatePrefermentationHours(-1).ok, false);
  assert.equal(validatePrefermentationHours('abc').ok, false);
  assert.equal(validatePrefermentationHours(Infinity).ok, false);
  assert.equal(validatePrefermentationHours(NaN).ok, false);
  assert.equal(validatePrefermentationHours(MAX_HOURS).ok, true);
  assert.equal(validatePrefermentationHours(MAX_HOURS + 1).ok, false);
});
