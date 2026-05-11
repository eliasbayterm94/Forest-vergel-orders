'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DRIED_TO_GREEN_DIVISORS, driedToGreen, greenToDried, driedOutputLabel,
  INPUT_STAGE_DIVISORS, inputToGreen, inputStageLabel,
  KG_PER_SACO, factorYield,
} = require('../netlify/functions/_lib/processYields');

test('default divisors match the seeded migration', () => {
  assert.equal(DRIED_TO_GREEN_DIVISORS.Natural, 3.40);
  assert.equal(DRIED_TO_GREEN_DIVISORS.Honey,   1.50);
  assert.equal(DRIED_TO_GREEN_DIVISORS.Lavado,  1.34);
});

test('Natural: 340 kg dried → 100 kg green', () => {
  assert.equal(driedToGreen(340, 'Natural'), 100);
});

test('Honey: 150 kg dried → 100 kg green', () => {
  assert.equal(driedToGreen(150, 'Honey'), 100);
});

test('Lavado: 134 kg dried → 100 kg green', () => {
  assert.equal(driedToGreen(134, 'Lavado'), 100);
});

test('rounds to 2 decimals', () => {
  // 1000 / 3.4 = 294.117647... → 294.12
  assert.equal(driedToGreen(1000, 'Natural'), 294.12);
});

test('green→dried inverse', () => {
  assert.equal(greenToDried(100, 'Natural'), 340);
  assert.equal(greenToDried(100, 'Honey'),   150);
  assert.equal(greenToDried(100, 'Lavado'),  134);
});

test('round-trip is approximately identity', () => {
  for (const proc of ['Natural', 'Honey', 'Lavado']) {
    const start = 87.5;
    const dried = greenToDried(start, proc);
    const back  = driedToGreen(dried, proc);
    assert.ok(Math.abs(back - start) < 0.05, `${proc} round-trip drift: ${back} vs ${start}`);
  }
});

test('rejects negative dried weight', () => {
  assert.throws(() => driedToGreen(-1, 'Natural'), TypeError);
});

test('rejects unknown process', () => {
  assert.throws(() => driedToGreen(100, 'Mystery'));
  assert.throws(() => greenToDried(100, 'Mystery'));
});

test('honors override divisor map (e.g. from DB)', () => {
  const map = { Natural: 3.5, Honey: 1.5, Lavado: 1.34 };
  assert.equal(driedToGreen(350, 'Natural', map), 100);
});

test('driedOutputLabel returns Spanish form', () => {
  assert.match(driedOutputLabel('Natural'), /Cereza seca/);
  assert.match(driedOutputLabel('Honey'),   /Pergamino/);
  assert.match(driedOutputLabel('Lavado'),  /Pergamino/);
  assert.match(driedOutputLabel('Other'),   /Producto seco/);
});

// ── Input-stage divisors ──────────────────────────────────────────
test('input-stage divisors match what ops specified', () => {
  assert.equal(INPUT_STAGE_DIVISORS.cereza,     7.65);
  assert.equal(INPUT_STAGE_DIVISORS.despulpado, 4.20);
  assert.equal(INPUT_STAGE_DIVISORS.seco,       1.34);
});

test('inputToGreen: cereza 765kg → 100kg green', () => {
  assert.equal(inputToGreen(765, 'cereza'), 100);
});

test('inputToGreen: despulpado 420kg → 100kg green', () => {
  assert.equal(inputToGreen(420, 'despulpado'), 100);
});

test('inputToGreen: seco 134kg → 100kg green', () => {
  assert.equal(inputToGreen(134, 'seco'), 100);
});

test('inputToGreen: rounds to 2 decimals', () => {
  // 100 / 4.20 = 23.809523... → 23.81
  assert.equal(inputToGreen(100, 'despulpado'), 23.81);
});

test('inputToGreen: rejects unknown stage', () => {
  assert.throws(() => inputToGreen(100, 'mojado'));
});

test('inputToGreen: rejects negative', () => {
  assert.throws(() => inputToGreen(-1, 'cereza'), TypeError);
});

test('inputStageLabel returns Spanish label', () => {
  assert.match(inputStageLabel('cereza'),     /Cereza fresca/);
  assert.match(inputStageLabel('despulpado'), /Despulpado/);
  assert.match(inputStageLabel('seco'),       /Seco/);
});

// ── Per-lot factor de rendimiento ──────────────────────────────────
test('KG_PER_SACO is 70', () => {
  assert.equal(KG_PER_SACO, 70);
});

test('factorYield: 1000 kg seco / factor 145 → 483 kg verde (entero)', () => {
  // (1000 / 145) * 70 = 482.7586... → redondea half-up a 483
  assert.equal(factorYield(1000, 145), 483);
});

test('factorYield: 700 kg seco / factor 100 → 490 kg verde', () => {
  // (700 / 100) * 70 = 490
  assert.equal(factorYield(700, 100), 490);
});

test('factorYield: redondea 0.5 hacia arriba', () => {
  // (1.0 / 1.0) * 70 = 70 exacto
  assert.equal(factorYield(1, 1), 70);
  // (250 / 138) * 70 = 126.8115942 → 127
  assert.equal(factorYield(250, 138), 127);
  // (250 / 150) * 70 = 116.6666... → 117
  assert.equal(factorYield(250, 150), 117);
});

test('factorYield: 0 dried → 0 green', () => {
  assert.equal(factorYield(0, 145), 0);
});

test('factorYield: rejects zero or negative factor', () => {
  assert.throws(() => factorYield(100, 0));
  assert.throws(() => factorYield(100, -1));
});

test('factorYield: rejects negative dried', () => {
  assert.throws(() => factorYield(-1, 100), TypeError);
});
