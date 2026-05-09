/**
 * Capacity engine — pure function.
 *
 * Inputs:
 *   orders: [{
 *     id, order_code, reference_id, reference_name,
 *     kg_green_required, kg_green_accepted, max_delivery_date,
 *     process_type, fermentation_hours
 *   }]
 *   activeLots: [{
 *     id, lot_code, status, kg_cherry_input, drying_start_date, start_date
 *   }]   -- in InFermentation | Drying | Resting
 *   dryingDaysByProcess: { Natural: 12, Honey: 8, Lavado: 8 }
 *   todayYmd: 'YYYY-MM-DD'  (Bogota)
 *
 * Outputs:
 *   {
 *     orders: [...with kg_cherry, latest_drying_start_date, urgency],
 *     aggregate: {...},
 *     weekly_load: [...],   ISO-week buckets
 *   }
 */

'use strict';

const { greenToCherry } = require('./cherryConversion');
const { latestDryingStartDate, urgencyOf } = require('./leadTime');
const { isoWeekOf, isoWeekStart, isoWeekEnd, isoWeekKey } = require('./isoWeek');
const { bogotaToday, daysBetween } = require('./bogotaTime');

function computeCapacity({
  orders = [],
  activeLots = [],
  dryingDaysByProcess,
  todayYmd = bogotaToday(),
}) {
  if (!dryingDaysByProcess) {
    throw new Error('computeCapacity: dryingDaysByProcess is required');
  }

  const enrichedOrders = orders.map((o) => {
    const kgGreen = Number(o.kg_green_accepted ?? o.kg_green_required ?? 0);
    const kgGreenRequired = Number(o.kg_green_required ?? 0);
    const latestStart = latestDryingStartDate(o.max_delivery_date, o.process_type, dryingDaysByProcess);
    return {
      id: o.id,
      order_code: o.order_code,
      reference_id: o.reference_id,
      reference_name: o.reference_name,
      process_type: o.process_type,
      max_delivery_date: o.max_delivery_date,
      kg_green_required: kgGreenRequired,
      kg_green_accepted: o.kg_green_accepted == null ? null : Number(o.kg_green_accepted),
      kg_green_for_planning: kgGreen,
      kg_cherry_for_planning: greenToCherry(kgGreen),
      kg_cherry_required: greenToCherry(kgGreenRequired),
      latest_drying_start_date: latestStart,
      urgency: urgencyOf(latestStart, todayYmd),
      iso_week_key: isoWeekKey(latestStart),
    };
  });

  // -------------------- aggregate --------------------
  const totalKgGreen = sum(enrichedOrders.map((o) => o.kg_green_for_planning));
  const totalKgCherry = round2(greenToCherry(totalKgGreen));

  let earliestStart = null;
  for (const o of enrichedOrders) {
    if (earliestStart === null || o.latest_drying_start_date < earliestStart) {
      earliestStart = o.latest_drying_start_date;
    }
  }
  const daysUntilEarliest = earliestStart ? daysBetween(todayYmd, earliestStart) : null;
  const weeksUntilEarliest = daysUntilEarliest == null
    ? null
    : Math.max(daysUntilEarliest / 7, 0);

  const avgKgGreenPerWeek = weeksUntilEarliest && weeksUntilEarliest > 0
    ? round2(totalKgGreen / weeksUntilEarliest)
    : null;
  const avgKgCherryPerWeek = avgKgGreenPerWeek != null
    ? round2(greenToCherry(avgKgGreenPerWeek))
    : null;

  const aggregate = {
    order_count: enrichedOrders.length,
    total_kg_green: round2(totalKgGreen),
    total_kg_cherry: totalKgCherry,
    earliest_drying_start_date: earliestStart,
    days_until_earliest_start: daysUntilEarliest,
    weeks_until_earliest_start: weeksUntilEarliest == null ? null : round2(weeksUntilEarliest),
    avg_kg_green_per_week: avgKgGreenPerWeek,
    avg_kg_cherry_per_week: avgKgCherryPerWeek,
  };

  // -------------------- weekly load --------------------
  /** @type {Map<string, any>} */
  const buckets = new Map();
  const ensureBucket = (ymd) => {
    const key = isoWeekKey(ymd);
    if (!buckets.has(key)) {
      const { isoYear, isoWeek } = isoWeekOf(ymd);
      buckets.set(key, {
        iso_year: isoYear,
        iso_week: isoWeek,
        iso_week_key: key,
        week_start_date: isoWeekStart(ymd),
        week_end_date: isoWeekEnd(ymd),
        selected_orders_kg_cherry: 0,
        selected_orders_kg_green: 0,
        selected_order_codes: [],
        active_queue_kg_cherry: 0,
        active_queue_lot_codes: [],
      });
    }
    return buckets.get(key);
  };

  for (const o of enrichedOrders) {
    const b = ensureBucket(o.latest_drying_start_date);
    b.selected_orders_kg_cherry = round2(b.selected_orders_kg_cherry + o.kg_cherry_for_planning);
    b.selected_orders_kg_green  = round2(b.selected_orders_kg_green  + o.kg_green_for_planning);
    b.selected_order_codes.push(o.order_code);
  }

  for (const lot of activeLots) {
    if (!['InFermentation', 'Drying', 'Resting'].includes(lot.status)) continue;
    const proxy = lot.drying_start_date || lot.start_date;
    if (!proxy) continue;
    const b = ensureBucket(proxy);
    b.active_queue_kg_cherry = round2(b.active_queue_kg_cherry + Number(lot.kg_cherry_input || 0));
    b.active_queue_lot_codes.push(lot.lot_code);
  }

  const weekly_load = Array.from(buckets.values())
    .sort((a, b) => a.week_start_date.localeCompare(b.week_start_date));

  return { orders: enrichedOrders, aggregate, weekly_load };
}

function sum(arr) { return arr.reduce((a, b) => a + Number(b || 0), 0); }
function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { computeCapacity };
