/**
 * ISO 8601 week helpers — Monday-first, week 1 contains the year's first Thursday.
 * Operates on YYYY-MM-DD strings (calendar days) to avoid timezone drift.
 */

'use strict';

const { dayUTC, fmtDate } = require('./bogotaTime');

/**
 * Returns {isoYear, isoWeek} for a YYYY-MM-DD calendar day.
 * Standard "shift to nearest Thursday" algorithm.
 */
function isoWeekOf(yyyyMmDd) {
  const d = dayUTC(yyyyMmDd);
  // Day-of-week with Monday=1..Sunday=7
  const dayNum = d.getUTCDay() || 7;
  // Shift to the Thursday of the same ISO week
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const isoWeek = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return { isoYear, isoWeek };
}

/** YYYY-MM-DD of the Monday of the ISO week containing `yyyyMmDd`. */
function isoWeekStart(yyyyMmDd) {
  const d = dayUTC(yyyyMmDd);
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (dayNum - 1));
  return fmtDate(d);
}

/** YYYY-MM-DD of the Sunday ending the ISO week containing `yyyyMmDd`. */
function isoWeekEnd(yyyyMmDd) {
  const start = isoWeekStart(yyyyMmDd);
  const d = dayUTC(start);
  d.setUTCDate(d.getUTCDate() + 6);
  return fmtDate(d);
}

/** Stable string key "YYYY-Www" — handy for grouping. */
function isoWeekKey(yyyyMmDd) {
  const { isoYear, isoWeek } = isoWeekOf(yyyyMmDd);
  return `${isoYear}-W${String(isoWeek).padStart(2, '0')}`;
}

module.exports = { isoWeekOf, isoWeekStart, isoWeekEnd, isoWeekKey };
