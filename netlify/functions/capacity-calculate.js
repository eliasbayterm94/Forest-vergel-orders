'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase, getDryingDaysByProcess, getProcessingDaysByProcess } = require('./_lib/supabase');
const { computeCapacity } = require('./_lib/capacity');
const { bogotaToday } = require('./_lib/bogotaTime');
const { ok, badReq, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /capacity-calculate  (any role)
 * Body:
 *   order_ids: [uuid]                      // orders to plan
 *   include_active_queue: boolean = true   // overlay current InFermentation/Drying/Resting lots
 *
 * Returns the full capacity payload:
 *   { orders: [...], aggregate: {...}, weekly_load: [{...}] }
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const order_ids = Array.isArray(body.order_ids) ? body.order_ids : [];
  const includeActive = body.include_active_queue !== false;
  if (order_ids.length === 0) return badReq('order_ids[] required', 'ORDER_IDS_REQUIRED');

  const sb = getSupabase();
  const { data: orderRows, error: oErr } = await sb
    .from('demand_orders')
    .select(`id, order_code, reference_id, kg_green_required, kg_green_accepted,
             max_delivery_date, process_type, fermentation_hours,
             coffee_references ( id, name )`)
    .in('id', order_ids);
  if (oErr) return serverErr('Order load failed', oErr.message);

  const orders = (orderRows || []).map((o) => ({
    id: o.id,
    order_code: o.order_code,
    reference_id: o.reference_id,
    reference_name: o.coffee_references && o.coffee_references.name,
    kg_green_required: Number(o.kg_green_required),
    kg_green_accepted: o.kg_green_accepted == null ? null : Number(o.kg_green_accepted),
    max_delivery_date: o.max_delivery_date,
    process_type: o.process_type,
    fermentation_hours: o.fermentation_hours,
  }));

  let activeLots = [];
  if (includeActive) {
    const { data: lots, error: lErr } = await sb
      .from('production_lots')
      .select(`
        id, lot_code, bache_code, status,
        kg_cherry_input, kg_green_expected, kg_green_actual,
        drying_start_date, start_date,
        lot_partials ( id, kg_green_yield, rejected_at )
      `)
      .in('status', ['InFermentation', 'Drying', 'Resting']);
    if (lErr) return serverErr('Active lot load failed', lErr.message);
    activeLots = (lots || []).map((l) => ({
      ...l,
      partials: l.lot_partials || [],
    }));
  }

  let dryingDaysByProcess, processingDaysByProcess;
  try {
    dryingDaysByProcess     = await getDryingDaysByProcess();
    processingDaysByProcess = await getProcessingDaysByProcess();
  } catch (e) { return serverErr('Lead-time load failed', e.message); }

  const result = computeCapacity({
    orders, activeLots,
    dryingDaysByProcess, processingDaysByProcess,
    todayYmd: bogotaToday(),
  });
  return ok(result);
});
