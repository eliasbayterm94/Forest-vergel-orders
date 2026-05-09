'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CHERRY_PER_GREEN, greenToCherry, cherryToGreen } = require('../netlify/functions/_lib/cherryConversion');

test('CHERRY_PER_GREEN constant', () => {
  assert.equal(CHERRY_PER_GREEN, 7.65);
});

test('greenToCherry: zero', () => {
  assert.equal(greenToCherry(0), 0);
});

test('greenToCherry: 100kg → 765kg', () => {
  assert.equal(greenToCherry(100), 765);
});

test('greenToCherry: rounds to 2 decimals', () => {
  assert.equal(greenToCherry(33.33), 254.97);
});

test('cherryToGreen: 765kg → 100kg', () => {
  assert.equal(cherryToGreen(765), 100);
});

test('round-trip is approximately identity', () => {
  const g = 250;
  const c = greenToCherry(g);
  assert.ok(Math.abs(cherryToGreen(c) - g) < 0.01);
});

test('greenToCherry: rejects negative', () => {
  assert.throws(() => greenToCherry(-1), TypeError);
});

test('greenToCherry: rejects NaN', () => {
  assert.throws(() => greenToCherry(NaN), TypeError);
});

test('greenToCherry: rejects non-number', () => {
  assert.throws(() => greenToCherry('100'), TypeError);
});
