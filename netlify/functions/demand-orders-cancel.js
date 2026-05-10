'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ORDER_STATUS } = require('./_lib/schema');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /demand-orders-cancel  (forest, admin)
 * Body: { order_id, reason? }
 *
 * Cancels a Pending order. To cancel orders already accepted by finca
 * (Accepted/PartiallyAccepted/InProduction) the operator must coordinate
 * out-of-band — that's not in MVP scope. The status trigger blocks
 * unsafe transitions anyway.
 */
exports.handler = requireAuth(['forest', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const order_id = body.order_id;
  if (!order_id) return badReq('order_id required', 'ORDER_ID_REQUIRED');
  const reason = body.reason == null ? null : String(body.reason).trim() || null;

  const sb = getSupabase();
  const { data: order, error: loadErr } = await sb
    .from('demand_orders').select('id, status, comments').eq('id', order_id).maybeSingle();
  if (loadErr) return serverErr('Lookup failed', loadErr.message);
  if (!order) return notFound('Order not found');
  if (order.status !== ORDER_STATUS.Pending) {
    return conflict(
      `Cannot cancel order in status "${order.status}" — only Pending orders can be cancelled from Forest.`,
      'NOT_CANCELLABLE',
    );
  }

  // Append reason to comments so we keep an audit trail.
  const newComments = reason
    ? [order.comments, `Cancelado: ${reason}`].filter(Boolean).join(' · ')
    : order.comments;

  const { data: updated, error: updErr } = await sb
    .from('demand_orders')
    .update({
      status: ORDER_STATUS.Cancelled,
      cancelled_at: new Date().toISOString(),
      comments: newComments,
    })
    .eq('id', order_id)
    .select()
    .single();
  if (updErr) return serverErr('Cancel failed', updErr.message);

  return ok({ order: updated });
});
