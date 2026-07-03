'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkDriedPlausibility, CONVERSION_BANDS } = require('../netlify/functions/_lib/plausibility');

// ── HARD: seco > entrada ─────────────────────────────────────────────
test('HARD: kg seco muy por encima de la entrada (typo 3000→35000)', () => {
  const r = checkDriedPlausibility({ kgInputInitial: 3000, kgDried: 35000, processingStage: 'cereza' });
  assert.ok(r.hardError, 'debe rechazar');
  assert.equal(r.confirmWarning, null);
});

test('HARD: tolerancia 5% de báscula — 1.04× pasa, 1.06× rebota', () => {
  const ok = checkDriedPlausibility({ kgInputInitial: 100, kgDried: 104, processingStage: 'seco' });
  assert.equal(ok.hardError, null);
  const bad = checkDriedPlausibility({ kgInputInitial: 100, kgDried: 106, processingStage: 'seco' });
  assert.ok(bad.hardError);
});

// ── CONFIRM por stage ────────────────────────────────────────────────
test('cereza: conversión 4.63 (Lavado real) pasa sin warning', () => {
  const r = checkDriedPlausibility({ kgInputInitial: 486, kgDried: 105, processingStage: 'cereza' });
  assert.equal(r.hardError, null);
  assert.equal(r.confirmWarning, null);
  assert.equal(r.conversion, 4.6286);
});

test('cereza: conversión 8× pide confirmación', () => {
  const r = checkDriedPlausibility({ kgInputInitial: 800, kgDried: 100, processingStage: 'cereza' });
  assert.equal(r.hardError, null);
  assert.ok(r.confirmWarning);
  assert.equal(r.conversion, 8);
});

test('cereza: conversión 1.8 (menor al mínimo 2.0) pide confirmación', () => {
  const r = checkDriedPlausibility({ kgInputInitial: 180, kgDried: 100, processingStage: 'cereza' });
  assert.ok(r.confirmWarning);
});

test('despulpado: 2.8 OK · 4.0 confirma', () => {
  assert.equal(checkDriedPlausibility({ kgInputInitial: 280, kgDried: 100, processingStage: 'despulpado' }).confirmWarning, null);
  assert.ok(checkDriedPlausibility({ kgInputInitial: 400, kgDried: 100, processingStage: 'despulpado' }).confirmWarning);
});

test('seco: 1.0 OK · 1.2 confirma', () => {
  assert.equal(checkDriedPlausibility({ kgInputInitial: 100, kgDried: 100, processingStage: 'seco' }).confirmWarning, null);
  assert.ok(checkDriedPlausibility({ kgInputInitial: 120, kgDried: 100, processingStage: 'seco' }).confirmWarning);
});

test('stage desconocido cae a banda de cereza', () => {
  const r = checkDriedPlausibility({ kgInputInitial: 300, kgDried: 100, processingStage: 'raro' });
  assert.equal(r.confirmWarning, null);   // 3.0 dentro de [2, 6]
});

// ── Skips ────────────────────────────────────────────────────────────
test('sin kgInputInitial no chequea nada', () => {
  const r = checkDriedPlausibility({ kgInputInitial: null, kgDried: 100, processingStage: 'cereza' });
  assert.deepEqual(r, { hardError: null, confirmWarning: null, conversion: null });
});

test('kgDried inválido (0, negativo, NaN) no chequea nada', () => {
  for (const kgDried of [0, -5, NaN]) {
    const r = checkDriedPlausibility({ kgInputInitial: 100, kgDried, processingStage: 'cereza' });
    assert.equal(r.hardError, null);
    assert.equal(r.confirmWarning, null);
  }
});

test('las bandas exportadas cubren los 3 stages', () => {
  assert.deepEqual(Object.keys(CONVERSION_BANDS).sort(), ['cereza', 'despulpado', 'seco']);
});
