/**
 * Lead-time utility — back-calculate latest_drying_start_date from
 * max_delivery_date using process_lead_times config.
 *
 * Drying days and processing days are loaded from the DB
 * (process_lead_times table) and passed in as maps; never hardcoded
 * in business logic.
 *
 * Formula:
 *   latest_drying_start = max_delivery - drying_days[process] - processing_days[process]
 *
 * processing_days representa fermentacion + despulpado + secado al
 * sol previo al cuarto de drying. Default 6 dias en migration 0016
 * pero ajustable por proceso.
 */

'use strict';

const { addDays, daysBetween, bogotaToday } = require('./bogotaTime');

/**
 * @param {string} maxDeliveryDate YYYY-MM-DD
 * @param {string} processType    'Natural' | 'Honey' | 'Lavado'
 * @param {Record<string, number>} dryingDaysByProcess
 * @param {Record<string, number>} [processingDaysByProcess]  optional
 *   buffer (fermentacion + despulpado). Si no se pasa, se asume 0
 *   (comportamiento legacy).
 * @returns {string} latest_drying_start_date YYYY-MM-DD
 */
function latestDryingStartDate(maxDeliveryDate, processType, dryingDaysByProcess, processingDaysByProcess = null) {
  const dryingDays = dryingDaysByProcess[processType];
  if (typeof dryingDays !== 'number' || !Number.isFinite(dryingDays) || dryingDays <= 0) {
    throw new Error(`latestDryingStartDate: missing/invalid drying_days for process_type "${processType}"`);
  }
  let processingDays = 0;
  if (processingDaysByProcess && processingDaysByProcess[processType] != null) {
    const p = Number(processingDaysByProcess[processType]);
    if (!Number.isFinite(p) || p < 0) {
      throw new Error(`latestDryingStartDate: invalid processing_days for process_type "${processType}"`);
    }
    processingDays = p;
  }
  return addDays(maxDeliveryDate, -(dryingDays + processingDays));
}

/**
 * Bucket urgency for the latest_drying_start_date relative to today (Bogota).
 *  past   — start date already in the past
 *  red    — within 3 days
 *  yellow — within 7 days
 *  normal — more than 7 days out
 * @param {string} latestStart YYYY-MM-DD
 * @param {string} [todayYmd]  optional reference (defaults to Bogota today)
 */
function urgencyOf(latestStart, todayYmd = bogotaToday()) {
  const delta = daysBetween(todayYmd, latestStart);
  if (delta < 0) return 'past';
  if (delta <= 3) return 'red';
  if (delta <= 7) return 'yellow';
  return 'normal';
}

module.exports = { latestDryingStartDate, urgencyOf };
