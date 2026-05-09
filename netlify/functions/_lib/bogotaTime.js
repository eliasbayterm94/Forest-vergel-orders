/**
 * Bogota timezone helpers.
 *
 * All operational date math (urgency thresholds, latest_drying_start_date,
 * order_code year prefix) runs in America/Bogota — never local server time
 * and never UTC. JS Date is fine for arithmetic; we only project to/from
 * Bogota for boundary comparisons (today, week start, etc.).
 */

'use strict';

const TZ = 'America/Bogota';
const MS_PER_DAY = 86_400_000;

/** Returns YYYY-MM-DD for `date` interpreted in America/Bogota. */
function bogotaDateString(date = new Date()) {
  // sv-SE locale produces YYYY-MM-DD HH:mm:ss with no localization quirks.
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date); // "YYYY-MM-DD"
}

/** Returns today's date in Bogota as a YYYY-MM-DD string. */
function bogotaToday() {
  return bogotaDateString(new Date());
}

/**
 * Build a Date that represents 00:00:00 on the given YYYY-MM-DD as a
 * "calendar day" — used only for date arithmetic, not for display.
 * Internally we use UTC midnight so `+ N * MS_PER_DAY` stays exact
 * (no DST in Bogota, but the abstraction is correct anyway).
 */
function dayUTC(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Format a Date (or date-only Date built via dayUTC) back to YYYY-MM-DD. */
function fmtDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Add N calendar days to a YYYY-MM-DD string. */
function addDays(yyyyMmDd, days) {
  const d = dayUTC(yyyyMmDd);
  d.setUTCDate(d.getUTCDate() + days);
  return fmtDate(d);
}

/** Whole-day difference (b − a). Positive if b is after a. */
function daysBetween(aYmd, bYmd) {
  const a = dayUTC(aYmd).getTime();
  const b = dayUTC(bYmd).getTime();
  return Math.round((b - a) / MS_PER_DAY);
}

module.exports = { TZ, MS_PER_DAY, bogotaToday, bogotaDateString, dayUTC, fmtDate, addDays, daysBetween };
