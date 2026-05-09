'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isoWeekOf, isoWeekStart, isoWeekEnd, isoWeekKey } = require('../netlify/functions/_lib/isoWeek');

test('isoWeekOf: mid-year Monday', () => {
  assert.deepEqual(isoWeekOf('2026-05-04'), { isoYear: 2026, isoWeek: 19 });
});

test('isoWeekOf: Sunday belongs to same ISO week as preceding Monday', () => {
  // 2026-05-10 is Sunday → still ISO week 19
  assert.deepEqual(isoWeekOf('2026-05-10'), { isoYear: 2026, isoWeek: 19 });
});

test('isoWeekOf: ISO year boundary — 2026-01-01 (Thursday) is W1 of 2026', () => {
  assert.deepEqual(isoWeekOf('2026-01-01'), { isoYear: 2026, isoWeek: 1 });
});

test('isoWeekOf: 2025-12-29 (Monday) belongs to ISO 2026 W1', () => {
  assert.deepEqual(isoWeekOf('2025-12-29'), { isoYear: 2026, isoWeek: 1 });
});

test('isoWeekOf: 2027-01-01 (Friday) is W53 of 2026', () => {
  assert.deepEqual(isoWeekOf('2027-01-01'), { isoYear: 2026, isoWeek: 53 });
});

test('isoWeekStart: returns Monday', () => {
  assert.equal(isoWeekStart('2026-05-09'), '2026-05-04'); // Sat → Mon of same week
  assert.equal(isoWeekStart('2026-05-10'), '2026-05-04'); // Sun (still same ISO week)
  assert.equal(isoWeekStart('2026-05-04'), '2026-05-04'); // Mon
});

test('isoWeekEnd: returns Sunday', () => {
  assert.equal(isoWeekEnd('2026-05-04'), '2026-05-10');
  assert.equal(isoWeekEnd('2026-05-09'), '2026-05-10');
});

test('isoWeekKey: zero-padded', () => {
  assert.equal(isoWeekKey('2026-01-05'), '2026-W02');
  assert.equal(isoWeekKey('2026-05-04'), '2026-W19');
});
