'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase, getDriedDivisorsByProcess } = require('./_lib/supabase');
const { driedToGreen } = require('./_lib/processYields');
const { LOT_STATUS, ORDER_STATUS } = require('./_lib/schema');
const { ok, badReq, notFound, conflict, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');
const { notifyOrderCompleted } = require('./_lib/notifications');
const { bogotaToday } = require('./_lib/bogotaTime');

/**
 * POST /production-lots-update-status  (finca, admin)
 * Body: { lot_id, status, kg_dried_output?, kg_green_actual? }
 *
 * Allowed transitions enforced by DB trigger; we mirror them here for
 * a clean error message and to set correlated date columns:
 *   InFermentation → Drying     ⇒ drying_start_date := today (if null)
 *   Drying        → Resting
 *   Resting       → Ready       ⇒ ready_date := today
 *   Ready         → Delivered   ⇒ delivered_date := today; check for order completion
 *
 * Yield handling:
 *   - If kg_dried_output is provided (or already on the lot) and
 *     kg_green_actual is omitted, kg_green_actual is auto-computed via
 *     the process-specific divisor:
 *       Natural / 3.40, Honey / 1.50, Lavado / 1.34
 *     (loaded from process_lead_times — DB is authoritative).
 *   - kg_green_actual passed in the body always wins.
 */
const NEXT = {
  [LOT_STATUS.InFermentation]: LOT_STATUS.Drying,
  [LOT_STATUS.Drying]:         LOT_STATUS.Resting,
  [LOT_STATUS.Resting]:        LOT_STATUS.Ready,
  [LOT_STATUS.Ready]:          LOT_STATUS.Delivered,
};

exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const { lot_id, status: targetStatus, kg_dried_output, kg_green_actual } = body || {};
  if (!lot_id) return badReq('lot_id required', 'LOT_ID_REQUIRED');
  if (!Object.values(LOT_STATUS).includes(targetStatus)) return badReq('invalid status', 'INVALID_STATUS');

  const sb = getSupabase();
  const { data: lot, error: loadErr } = await sb
    .from('production_lots').select('*').eq('id', lot_id).maybeSingle();
  if (loadErr) return serverErr('Lookup failed', loadErr.message);
  if (!lot) return notFound('Lot not found');
  if (NEXT[lot.status] !== targetStatus) {
    return conflict(`Invalid lot status transition: ${lot.status} -> ${targetStatus}`, 'INVALID_TRANSITION');
  }

  const today = bogotaToday();
  const update = { status: targetStatus };
  if (targetStatus === LOT_STATUS.Drying    && !lot.drying_start_date) update.drying_start_date = today;
  if (targetStatus === LOT_STATUS.Ready)     update.ready_date = today;
  if (targetStatus === LOT_STATUS.Delivered) update.delivered_date = today;

  if (kg_dried_output != null) {
    const n = Number(kg_dried_output);
    if (!Number.isFinite(n) || n < 0) return badReq('kg_dried_output must be >= 0', 'INVALID_DRIED');
    update.kg_dried_output = n;
  }
  if (kg_green_actual != null) {
    const n = Number(kg_green_actual);
    if (!Number.isFinite(n) || n < 0) return badReq('kg_green_actual must be >= 0', 'INVALID_KG');
    update.kg_green_actual = n;
  } else {
    // Auto-compute kg_green_actual when we have a dried-output reading
    // (just provided or already stored) and the body didn't override it.
    const effectiveDried = kg_dried_output != null ? Number(kg_dried_output) : lot.kg_dried_output;
    if (effectiveDried != null && Number.isFinite(Number(effectiveDried)) && Number(effectiveDried) >= 0) {
      try {
        const divisors = await getDriedDivisorsByProcess();
        update.kg_green_actual = driedToGreen(Number(effectiveDried), lot.process_type, divisors);
      } catch (e) {
        return serverErr('Yield calc failed', e.message);
      }
    }
  }

  const { data: updated, error: updErr } = await sb
    .from('production_lots').update(update).eq('id', lot_id).select().single();
  if (updErr) return serverErr('Update failed', updErr.message);

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

async function maybeCompleteOrder(sb, order_id) {
  const { data: order, error } = await sb
    .from('demand_orders')
    .select(`*, coffee_references(id,name)`)
    .eq('id', order_id).maybeSingle();
  if (error || !order) return null;
  if (order.status !== ORDER_STATUS.InProduction) return null;

  // Sum allocations from delivered lots only
  const { data: delivered, error: dErr } = await sb
    .from('lot_order_assignments')
    .select('kg_green_allocated, production_lots!inner(status)')
    .eq('demand_order_id', order_id)
    .eq('production_lots.status', LOT_STATUS.Delivered);
  if (dErr) return null;

  const totalDelivered = (delivered || []).reduce((s, r) => s + Number(r.kg_green_allocated || 0), 0);
  if (totalDelivered + 1e-6 < Number(order.kg_green_accepted)) return null;

  const { data: completed, error: upErr } = await sb
    .from('demand_orders').update({
      status: ORDER_STATUS.Completed,
      completed_at: new Date().toISOString(),
    }).eq('id', order_id).select().single();
  if (upErr) return null;

  const ref = order.coffee_references || { name: '' };
  const notif = await notifyOrderCompleted(completed, ref);
  return { order_id, notification: notif };
}
