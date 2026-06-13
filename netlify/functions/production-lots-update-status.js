'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase, getDriedDivisorsByProcess } = require('./_lib/supabase');
const { driedToGreen, factorYield } = require('./_lib/processYields');
const { LOT_STATUS, ORDER_STATUS } = require('./_lib/schema');
const { ok, badReq, notFound, conflict, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');
const { maybeCompleteOrder } = require('./_lib/orderCompletion');
const { bogotaToday } = require('./_lib/bogotaTime');

/**
 * POST /production-lots-update-status  (finca, admin)
 * Body: {
 *   lot_id, status,
 *   kg_dried_output?, factor_rendimiento?, kg_green_actual?,
 *   drying_start_date?, drying_locations?,
 *   resting_start_date?, resting_humidity?
 * }
 *
 * Lot lifecycle:
 *
 *   InFermentation → Drying    ⇒ drying_start_date := today, drying_locations
 *   Drying        → Resting    ⇒ resting_start_date := today, resting_humidity
 *   Drying        → Ready      ⇒ ready_date := today  (skip-Resting path)
 *   Resting       → Ready      ⇒ ready_date := today
 *   Resting       → Drying     ⇒ regreso: drying_start_date := today, drying_locations
 *                                          resting_start_date/_humidity quedan
 *                                          en NULL para que el próximo Drying →
 *                                          Resting pida humedad nueva.
 *   Ready         → Delivered  ⇒ delivered_date := today; cascade order completion
 *
 * Yield handling at Ready/Delivered idéntico al previo.
 */
const VALID_TRANSITIONS = {
  InFermentation: ['Drying'],
  Drying:         ['Resting', 'Ready'],
  Resting:        ['Ready', 'Drying'],
  Ready:          ['Delivered'],
};

const DRYING_LOCATION_OPTIONS = new Set(['Silos', 'Patio']);

exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const {
    lot_id, status: targetStatus,
    kg_dried_output, factor_rendimiento, kg_green_actual,
    drying_start_date, drying_locations,
    resting_start_date, resting_humidity,
    resting_exit_humidity, // requerida al salir de Resting (a Drying o Ready)
    ready_date,            // opcional, default hoy (al pasar a Ready)
    final_humidity,        // opcional, humedad de la matriz al cerrar el bache
  } = body || {};
  if (!lot_id) return badReq('lot_id required', 'LOT_ID_REQUIRED');
  if (!Object.values(LOT_STATUS).includes(targetStatus)) return badReq('invalid status', 'INVALID_STATUS');
  if (drying_start_date != null && !/^\d{4}-\d{2}-\d{2}$/.test(drying_start_date)) {
    return badReq('drying_start_date must be YYYY-MM-DD', 'INVALID_DATE');
  }
  if (resting_start_date != null && !/^\d{4}-\d{2}-\d{2}$/.test(resting_start_date)) {
    return badReq('resting_start_date must be YYYY-MM-DD', 'INVALID_DATE');
  }
  let normalizedLocations = null;
  if (drying_locations != null) {
    if (!Array.isArray(drying_locations)) return badReq('drying_locations must be array', 'INVALID_LOCATIONS');
    const cleaned = [...new Set(drying_locations.map((s) => String(s).trim()).filter(Boolean))];
    for (const x of cleaned) {
      if (!DRYING_LOCATION_OPTIONS.has(x)) {
        return badReq(`drying_locations: valor inválido "${x}". Opciones: Silos, Patio.`, 'INVALID_LOCATIONS');
      }
    }
    normalizedLocations = cleaned;
  }
  let normalizedHumidity = null;
  if (resting_humidity != null) {
    const n = Number(resting_humidity);
    if (!Number.isFinite(n) || n < 8 || n > 40) {
      return badReq('resting_humidity debe estar entre 8 y 40', 'INVALID_HUMIDITY');
    }
    normalizedHumidity = Math.round(n * 100) / 100;
  }
  let normalizedExitHumidity = null;
  if (resting_exit_humidity != null) {
    const n = Number(resting_exit_humidity);
    if (!Number.isFinite(n) || n < 8 || n > 40) {
      return badReq('resting_exit_humidity debe estar entre 8 y 40', 'INVALID_HUMIDITY');
    }
    normalizedExitHumidity = Math.round(n * 100) / 100;
  }
  if (ready_date != null && !/^\d{4}-\d{2}-\d{2}$/.test(ready_date)) {
    return badReq('ready_date must be YYYY-MM-DD', 'INVALID_DATE');
  }
  let normalizedFinalHumidity = null;
  if (final_humidity != null && final_humidity !== '') {
    const n = Number(final_humidity);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return badReq('final_humidity debe estar entre 0 y 100', 'INVALID_HUMIDITY');
    }
    normalizedFinalHumidity = Math.round(n * 100) / 100;
  }

  const sb = getSupabase();
  const { data: lot, error: loadErr } = await sb
    .from('production_lots').select('*').eq('id', lot_id).maybeSingle();
  if (loadErr) return serverErr('Lookup failed', loadErr.message);
  if (!lot) return notFound('Lot not found');
  const allowed = VALID_TRANSITIONS[lot.status] || [];
  if (!allowed.includes(targetStatus)) {
    return conflict(`Transición no permitida: ${lot.status} → ${targetStatus}`, 'INVALID_TRANSITION');
  }

  const today = bogotaToday();
  const update = { status: targetStatus };
  const isLeavingResting = lot.status === LOT_STATUS.Resting &&
    (targetStatus === LOT_STATUS.Drying || targetStatus === LOT_STATUS.Ready);

  if (isLeavingResting && normalizedExitHumidity == null) {
    return badReq('resting_exit_humidity es requerido al salir de Descanso', 'EXIT_HUMIDITY_REQUIRED');
  }

  if (targetStatus === LOT_STATUS.Drying) {
    // InFermentation → Drying (primera vez) o Resting → Drying (regreso).
    update.drying_start_date = drying_start_date || today;
    if (normalizedLocations != null) update.drying_locations = normalizedLocations;
    // Si vuelve de Descanso, limpiamos los datos de Resting para que la
    // próxima entrada vuelva a pedir humedad fresca.
    if (lot.status === LOT_STATUS.Resting) {
      update.resting_start_date = null;
      update.resting_humidity = null;
    }
  }
  if (targetStatus === LOT_STATUS.Resting) {
    update.resting_start_date = resting_start_date || today;
    if (normalizedHumidity == null) {
      return badReq('resting_humidity es requerido al entrar a Descanso', 'HUMIDITY_REQUIRED');
    }
    update.resting_humidity = normalizedHumidity;
  }
  if (targetStatus === LOT_STATUS.Ready) {
    update.ready_date = ready_date || today;
    // Humedad final: si el operario la ingresó la usamos; si no, y
    // venimos de Resting, caemos a la humedad de salida del reposo
    // (esa misma es la humedad final del bache).
    if (normalizedFinalHumidity != null) {
      update.final_humidity = normalizedFinalHumidity;
    } else if (normalizedExitHumidity != null) {
      update.final_humidity = normalizedExitHumidity;
    }
  }
  if (targetStatus === LOT_STATUS.Delivered) update.delivered_date = today;

  if (kg_dried_output != null) {
    const n = Number(kg_dried_output);
    if (!Number.isFinite(n) || n < 0) return badReq('kg_dried_output must be >= 0', 'INVALID_DRIED');
    update.kg_dried_output = n;
  }
  if (factor_rendimiento != null) {
    const n = Number(factor_rendimiento);
    if (!Number.isFinite(n) || n <= 0) return badReq('factor_rendimiento must be > 0', 'INVALID_FACTOR');
    update.factor_rendimiento = n;
  }

  // When closing the bache (Drying → Ready or Drying → Resting → Ready) we
  // prefer the sum of registered partials over any provided dried/factor.
  // The parcial-by-parcial yields are authoritative once they exist.
  let usedPartials = false;
  if (targetStatus === LOT_STATUS.Ready) {
    const { data: partials, error: pErr } = await sb
      .from('lot_partials')
      .select('kg_dried, factor_rendimiento, kg_green_yield')
      .eq('production_lot_id', lot_id);
    if (pErr) return serverErr('Partials lookup failed', pErr.message);

    if ((partials || []).length > 0) {
      usedPartials = true;
      let sumDried = 0;
      let sumGreen = 0;
      let weightedFactorNum = 0;  // Σ(factor_i · kg_dried_i)
      for (const p of partials) {
        const d = Number(p.kg_dried);
        const f = Number(p.factor_rendimiento);
        const g = Number(p.kg_green_yield);
        sumDried += d;
        sumGreen += g;
        weightedFactorNum += f * d;
      }
      update.kg_dried_output    = Math.round(sumDried * 100) / 100;
      update.kg_green_actual    = Math.round(sumGreen * 100) / 100;
      update.factor_rendimiento = sumDried > 0
        ? Math.round((weightedFactorNum / sumDried) * 10000) / 10000
        : null;
    }
  }

  if (!usedPartials) {
    if (kg_green_actual != null) {
      const n = Number(kg_green_actual);
      if (!Number.isFinite(n) || n < 0) return badReq('kg_green_actual must be >= 0', 'INVALID_KG');
      update.kg_green_actual = n;
    } else {
      // Auto-compute kg_green_actual:
      //   1) factor + dried → per-lot formula (preferred)
      //   2) dried only      → per-process divisor (legacy fallback)
      const effectiveDried  = kg_dried_output    != null ? Number(kg_dried_output)    : lot.kg_dried_output;
      const effectiveFactor = factor_rendimiento != null ? Number(factor_rendimiento) : lot.factor_rendimiento;

      if (effectiveDried != null && Number.isFinite(Number(effectiveDried)) && Number(effectiveDried) >= 0) {
        try {
          if (effectiveFactor != null && Number.isFinite(Number(effectiveFactor)) && Number(effectiveFactor) > 0) {
            update.kg_green_actual = factorYield(Number(effectiveDried), Number(effectiveFactor));
          } else {
            const divisors = await getDriedDivisorsByProcess();
            update.kg_green_actual = driedToGreen(Number(effectiveDried), lot.process_type, divisors);
          }
        } catch (e) {
          return serverErr('Yield calc failed', e.message);
        }
      }
    }
  }

  // Si vamos a cerrar el bache (Ready), calcular conversion_factor a partir
  // del kg_input_initial (congelado al crear) y el kg_dried_output final.
  if (targetStatus === LOT_STATUS.Ready) {
    const finalDried = update.kg_dried_output != null ? Number(update.kg_dried_output) : lot.kg_dried_output;
    const initial    = lot.kg_input_initial != null ? Number(lot.kg_input_initial) : null;
    if (initial != null && finalDried != null && finalDried > 0) {
      update.conversion_factor = Math.round((initial / finalDried) * 10000) / 10000;
    }
  }

  const { data: updated, error: updErr } = await sb
    .from('production_lots').update(update).eq('id', lot_id).select().single();
  if (updErr) return serverErr('Update failed', updErr.message);

  // Histórico de ciclos de descanso. Cada Drying → Resting abre un ciclo;
  // cada Resting → Drying / Ready lo cierra con su humedad de salida.
  if (targetStatus === LOT_STATUS.Resting) {
    const { data: prev } = await sb
      .from('lot_resting_cycles').select('cycle_number')
      .eq('production_lot_id', lot_id)
      .order('cycle_number', { ascending: false }).limit(1);
    const nextCycle = (prev && prev[0] ? prev[0].cycle_number : 0) + 1;
    const { error: cycErr } = await sb.from('lot_resting_cycles').insert({
      production_lot_id: lot_id,
      cycle_number: nextCycle,
      start_date: update.resting_start_date,
      start_humidity: normalizedHumidity,
    });
    if (cycErr) console.warn('Resting cycle insert failed', cycErr.message);
  }
  if (isLeavingResting) {
    // Cerramos el ciclo activo (el de mayor cycle_number sin end_date).
    const { data: active } = await sb
      .from('lot_resting_cycles').select('id')
      .eq('production_lot_id', lot_id).is('end_date', null)
      .order('cycle_number', { ascending: false }).limit(1);
    const activeId = active && active[0] && active[0].id;
    if (activeId) {
      const { error: cycErr } = await sb.from('lot_resting_cycles').update({
        end_date: today,
        end_humidity: normalizedExitHumidity,
        end_reason: targetStatus === LOT_STATUS.Drying ? 'back_to_drying' : 'to_ready',
      }).eq('id', activeId);
      if (cycErr) console.warn('Resting cycle close failed', cycErr.message);
    }
  }

  // Cascade: when lot reaches Delivered, check each assigned order for completion.
  const completions = [];
  if (targetStatus === LOT_STATUS.Delivered) {
    const { data: assigns, error: aErr } = await sb
      .from('lot_order_assignments').select('demand_order_id').eq('production_lot_id', lot_id);
    if (aErr) return serverErr('Assignment lookup failed', aErr.message);

    for (const a of assigns || []) {
      const result = await maybeCompleteOrder(sb, a.demand_order_id);
      if (result) completions.push(result);
    }
  }

  // Cascade: when first lot moves toward production for an Accepted/PartiallyAccepted
  // order, transition that order to InProduction (one-way). We do this on any
  // status change to keep logic simple.
  await maybePromoteOrdersToInProduction(sb, lot_id);

  return ok({ lot: updated, completions });
});

async function maybePromoteOrdersToInProduction(sb, lot_id) {
  const { data: assigns } = await sb
    .from('lot_order_assignments').select('demand_order_id').eq('production_lot_id', lot_id);
  if (!assigns) return;
  for (const a of assigns) {
    const { data: order } = await sb
      .from('demand_orders').select('id, status').eq('id', a.demand_order_id).maybeSingle();
    if (!order) continue;
    if (order.status === ORDER_STATUS.Accepted || order.status === ORDER_STATUS.PartiallyAccepted) {
      await sb.from('demand_orders').update({
        status: ORDER_STATUS.InProduction,
        in_production_at: new Date().toISOString(),
      }).eq('id', order.id);
    }
  }
}

