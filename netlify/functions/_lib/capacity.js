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

// Limite operativo de la planta para procesamiento de cereza por semana.
// Si la suma de pedidos + lots activos en una semana ISO supera esto,
// la semana queda "sobrecargada" y la UI lo marca en rojo.
const DEFAULT_WEEKLY_CHERRY_CAPACITY_KG = 60000;

function computeCapacity({
  orders = [],
  activeLots = [],
  dryingDaysByProcess,
  processingDaysByProcess = null,
  weeklyCherryCapacityKg = DEFAULT_WEEKLY_CHERRY_CAPACITY_KG,
  todayYmd = bogotaToday(),
}) {
  if (!dryingDaysByProcess) {
    throw new Error('computeCapacity: dryingDaysByProcess is required');
  }

  const enrichedOrders = orders.map((o) => {
    const kgGreen = Number(o.kg_green_accepted ?? o.kg_green_required ?? 0);
    const kgGreenRequired = Number(o.kg_green_required ?? 0);
    const latestStart = latestDryingStartDate(o.max_delivery_date, o.process_type, dryingDaysByProcess, processingDaysByProcess);
    // Para la distribución de carga semanal usamos el periodo
    // acceptance → latest_drying_start_date. Si no hay acceptance (raro),
    // caemos a hoy para que la carga arranque ya.
    const acceptedYmd = o.accepted_at ? String(o.accepted_at).slice(0, 10) : null;
    const planStart = acceptedYmd && acceptedYmd < latestStart ? acceptedYmd : todayYmd;
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
      plan_start_date: planStart,
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
        active_queue_kg_green_lost_to_rejection: 0,
        active_queue_rejected_partial_count: 0,
      });
    }
    return buckets.get(key);
  };

  for (const o of enrichedOrders) {
    // Distribuir la cereza del pedido entre todas las semanas ISO del
    // periodo [plan_start_date → latest_drying_start_date]. Refleja que
    // el bache se trabaja desde que se acepta hasta el plazo limite de
    // empezar a secar. Cada semana del periodo recibe una porcion igual.
    const weeks = isoWeeksBetween(o.plan_start_date, o.latest_drying_start_date);
    if (weeks.length === 0) {
      // Fallback: no hay periodo (plan_start >= latest_start) — todo a
      // la semana de inicio de drying.
      const b = ensureBucket(o.latest_drying_start_date);
      b.selected_orders_kg_cherry = round2(b.selected_orders_kg_cherry + o.kg_cherry_for_planning);
      b.selected_orders_kg_green  = round2(b.selected_orders_kg_green  + o.kg_green_for_planning);
      if (!b.selected_order_codes.includes(o.order_code)) b.selected_order_codes.push(o.order_code);
      continue;
    }
    const cherryPerWeek = o.kg_cherry_for_planning / weeks.length;
    const greenPerWeek  = o.kg_green_for_planning  / weeks.length;
    for (const wk of weeks) {
      const b = ensureBucket(wk);
      b.selected_orders_kg_cherry = round2(b.selected_orders_kg_cherry + cherryPerWeek);
      b.selected_orders_kg_green  = round2(b.selected_orders_kg_green  + greenPerWeek);
      if (!b.selected_order_codes.includes(o.order_code)) b.selected_order_codes.push(o.order_code);
    }
  }

  for (const lot of activeLots) {
    if (!['InFermentation', 'Drying', 'Resting'].includes(lot.status)) continue;
    const proxy = lot.drying_start_date || lot.start_date;
    if (!proxy) continue;
    const b = ensureBucket(proxy);
    b.active_queue_kg_cherry = round2(b.active_queue_kg_cherry + Number(lot.kg_cherry_input || 0));
    b.active_queue_lot_codes.push(lot.bache_code || lot.lot_code);

    // Aporte de partials rechazados: kg verde que NO se va a producir
    // por mucho que el cereza original ya este en proceso.
    const partials = Array.isArray(lot.partials) ? lot.partials : [];
    const rejected = partials.filter((p) => p && p.rejected_at);
    if (rejected.length > 0) {
      const lostKgGreen = rejected.reduce(
        (s, p) => s + Number(p.kg_green_yield || 0), 0);
      b.active_queue_kg_green_lost_to_rejection = round2(
        b.active_queue_kg_green_lost_to_rejection + lostKgGreen);
      b.active_queue_rejected_partial_count += rejected.length;
    }
  }

  // Enriquecer cada bucket con totales y semaforo respecto a la
  // capacidad operativa semanal de cereza.
  for (const b of buckets.values()) {
    const totalCherry = Number(b.selected_orders_kg_cherry || 0)
                      + Number(b.active_queue_kg_cherry || 0);
    b.total_cherry_kg     = round2(totalCherry);
    b.capacity_kg         = weeklyCherryCapacityKg;
    b.capacity_pct        = weeklyCherryCapacityKg > 0
      ? round2((totalCherry / weeklyCherryCapacityKg) * 100) : null;
    b.is_overloaded       = totalCherry > weeklyCherryCapacityKg + 0.01;
    b.overloaded_by_kg    = b.is_overloaded ? round2(totalCherry - weeklyCherryCapacityKg) : 0;
  }

  const weekly_load = Array.from(buckets.values())
    .sort((a, b) => a.week_start_date.localeCompare(b.week_start_date));

  return {
    orders: enrichedOrders,
    aggregate,
    weekly_load,
    weekly_cherry_capacity_kg: weeklyCherryCapacityKg,
  };
}

function sum(arr) { return arr.reduce((a, b) => a + Number(b || 0), 0); }
function round2(n) { return Math.round(n * 100) / 100; }

// Devuelve la lista de YYYY-MM-DD (uno por semana ISO) que cubre el
// rango [startYmd, endYmd], inclusivo en semana. Cada string es el
// lunes de la semana ISO. Si end < start, devuelve [].
function isoWeeksBetween(startYmd, endYmd) {
  if (!startYmd || !endYmd) return [];
  const startMon = require('./isoWeek').isoWeekStart(startYmd);
  const endMon   = require('./isoWeek').isoWeekStart(endYmd);
  if (endMon < startMon) return [];
  const weeks = [];
  // Iterar lunes a lunes hasta endMon inclusivo. Limit defensivo (200 semanas).
  let cursor = startMon;
  for (let i = 0; i < 200; i++) {
    weeks.push(cursor);
    if (cursor === endMon) break;
    const [y, m, d] = cursor.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 7);
    cursor = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  }
  return weeks;
}

module.exports = { computeCapacity };
