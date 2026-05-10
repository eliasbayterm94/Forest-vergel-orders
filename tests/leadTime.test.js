'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { latestDryingStartDate, urgencyOf } = require('../netlify/functions/_lib/leadTime');

const LEAD = { Natural: 12, Honey: 8, Lavado: 8 };

test('Natural: 12 days back from delivery (no processing)', () => {
  assert.equal(latestDryingStartDate('2026-06-01', 'Natural', LEAD), '2026-05-20');
});

test('Natural: 12 drying + 6 processing = 18 days back', () => {
  const PROC = { Natural: 6, Honey: 6, Lavado: 6 };
  assert.equal(latestDryingStartDate('2026-06-01', 'Natural', LEAD, PROC), '2026-05-14');
});

test('Honey: 8 drying + 6 processing = 14 days back', () => {
  const PROC = { Natural: 6, Honey: 6, Lavado: 6 };
  assert.equal(latestDryingStartDate('2026-06-01', 'Honey', LEAD, PROC), '2026-05-18');
});

test('processing_days zero in map = legacy behavior', () => {
  const PROC = { Natural: 0 };
  assert.equal(latestDryingStartDate('2026-06-01', 'Natural', LEAD, PROC), '2026-05-20');
});

test('throws on invalid (negative) processing_days', () => {
  const PROC = { Natural: -1 };
  assert.throws(() => latestDryingStartDate('2026-06-01', 'Natural', LEAD, PROC));
});

test('Honey: 8 days back', () => {
  assert.equal(latestDryingStartDate('2026-06-01', 'Honey', LEAD), '2026-05-24');
});

test('Lavado: 8 days back', () => {
  assert.equal(latestDryingStartDate('2026-06-01', 'Lavado', LEAD), '2026-05-24');
});

test('crosses month boundary', () => {
  assert.equal(latestDryingStartDate('2026-03-05', 'Natural', LEAD), '2026-02-21');
});

test('crosses year boundary', () => {
  assert.equal(latestDryingStartDate('2026-01-05', 'Natural', LEAD), '2025-12-24');
});

test('throws on unknown process', () => {
  assert.throws(() => latestDryingStartDate('2026-06-01', 'Mystery', LEAD));
});

test('urgencyOf: past', () => {
  assert.equal(urgencyOf('2026-05-08', '2026-05-09'), 'past');
});

test('urgencyOf: red (today)', () => {
  assert.equal(urgencyOf('2026-05-09', '2026-05-09'), 'red');
});

test('urgencyOf: red (3 days out)', () => {
  assert.equal(urgencyOf('2026-05-12', '2026-05-09'), 'red');
});

test('urgencyOf: yellow (4-7 days)', () => {
  assert.equal(urgencyOf('2026-05-13', '2026-05-09'), 'yellow');
  assert.equal(urgencyOf('2026-05-16', '2026-05-09'), 'yellow');
});

test('urgencyOf: normal (>7 days)', () => {
  assert.equal(urgencyOf('2026-05-17', '2026-05-09'), 'normal');
});
