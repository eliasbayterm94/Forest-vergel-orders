'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ORDER_STATUS } = require('./_lib/schema');
const { ok, badReq, notFound, conflict, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');
const { notifyDemandAccepted } = require('./_lib/notifications');

/**
 * POST /demand-orders-accept  (finca, admin)
 * Body: { order_id, kg_green_accepted? }
 *   - omit kg_green_accepted → full accept
 *   - 0 < kg_green_accepted < kg_green_required → partial accept
 *   - kg_green_accepted === kg_green_required → full accept
 *
 * The remainder (required − accepted) becomes external-supplier need
 * for Forest to handle via PO; nothing is recorded beyond status +
 * kg_green_accepted (the math is derived).
 */
exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const order_id = body.order_id;
  if (!order_id) return badReq('order_id required', 'ORDER_ID_REQUIRED');
  const explicitAccept = body.kg_green_accepted != null;
  const kg_green_accepted = explicitAccept ? Number(body.kg_green_accepted) : null;
  if (explicitAccept && (!Number.isFinite(kg_green_accepted) || kg_green_accepted < 0)) {
    return badReq('kg_green_accepted must be >= 0', 'INVALID_KG');
  }

  const sb = getSupabase();
  const { data: order, error: loadErr } = await sb
    .from('demand_orders')
    .select(`*, coffee_references(id,name)`)
    .eq('id', order_id).maybeSingle();
  if (loadErr) return serverErr('Lookup failed', loadErr.message);
  if (!order) return notFound('Order not found');
  if (order.status !== ORDER_STATUS.Pending) {
    return conflict(`Cannot accept order in status "${order.status}"`, 'INVALID_STATUS');
  }

  const required = Number(order.kg_green_required);
  const accepted = explicitAccept ? kg_green_accepted : required;
  if (accepted > required) return badReq('kg_green_accepted exceeds kg_green_required', 'EXCEEDS_REQUIRED');
  if (accepted === 0) return badReq('Use /demand-orders-reject for full rejection', 'USE_REJECT');

  const newStatus = accepted === required ? ORDER_STATUS.Accepted : ORDER_STATUS.PartiallyAccepted;
  const { data: updated, error: updErr } = await sb
    .from('demand_orders')
    .update({
      kg_green_accepted: accepted,
      status: newStatus,
      accepted_at: new Date().toISOString(),
    })
    .eq('id', order_id)
    .select()
    .single();
  if (updErr) return serverErr('Update failed', updErr.message);

  // Fire-and-await notification (low volume, OK to await)
  const ref = order.coffee_references || { name: '' };
  const notif = await notifyDemandAccepted(updated, ref);

  return ok({ order: updated, notification: notif });
});
