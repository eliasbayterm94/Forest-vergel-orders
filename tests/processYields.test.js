'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DRIED_TO_GREEN_DIVISORS, driedToGreen, greenToDried, driedOutputLabel,
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
