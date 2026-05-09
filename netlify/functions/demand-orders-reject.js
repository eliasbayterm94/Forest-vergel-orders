'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ORDER_STATUS } = require('./_lib/schema');
const { ok, badReq, notFound, conflict, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');
const { notifyDemandRejected } = require('./_lib/notifications');

/**
 * POST /demand-orders-reject  (finca, admin)
 * Body: { order_id, rejection_reason? }
 * Sets status=Rejected, kg_green_accepted=0; the entire kg_green_required
 * becomes the external-supplier remainder for Forest to source.
 */
exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const order_id = body.order_id;
  if (!order_id) return badReq('order_id required', 'ORDER_ID_REQUIRED');
  const rejection_reason = body.rejection_reason == null ? null : String(body.rejection_reason);

  const sb = getSupabase();
  const { data: order, error: loadErr } = await sb
    .from('demand_orders').select(`*, coffee_references(id,name)`)
    .eq('id', order_id).maybeSingle();
  if (loadErr) return serverErr('Lookup failed', loadErr.message);
  if (!order) return notFound('Order not found');
  if (order.status !== ORDER_STATUS.Pending) {
    return conflict(`Cannot reject order in status "${order.status}"`, 'INVALID_STATUS');
  }

  const { data: updated, error: updErr } = await sb
    .from('demand_orders')
    .update({
      kg_green_accepted: 0,
      status: ORDER_STATUS.Rejected,
      rejection_reason,
      rejected_at: new Date().toISOString(),
    })
    .eq('id', order_id)
    .select()
    .single();
  if (updErr) return serverErr('Update failed', updErr.message);

  const ref = order.coffee_references || { name: '' };
  const notif = await notifyDemandRejected(updated, ref);

  return ok({ order: updated, notification: notif });
});
