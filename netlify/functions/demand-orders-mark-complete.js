'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ORDER_STATUS } = require('./_lib/schema');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /demand-orders-mark-complete  (forest, finca, admin)
 * Body: { order_id, reason }
 *
 * Cierra un pedido manualmente. Útil cuando el flujo automático
 * (maybeCompleteOrder corre al despachar lotes asignados) no
 * dispara — por ejemplo cuando el bache se despachó sin estar
 * asignado al pedido correcto.
 *
 * Valida:
 *   - order_id requerido
 *   - reason requerido (texto, max 1000 chars). Va anexado a
 *     comments con marca "Cerrado manualmente: <razón>".
 *   - status actual ∈ {Accepted, PartiallyAccepted, InProduction}
 *
 * Resultado:
 *   - status = Completed
 *   - completed_at = now()
 *   - comments anexado
 */
const CLOSEABLE_STATUSES = new Set([
  ORDER_STATUS.Accepted,
  ORDER_STATUS.PartiallyAccepted,
  ORDER_STATUS.InProduction,
]);

exports.handler = requireAuth(['forest', 'finca', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const order_id = body.order_id;
  const reasonRaw = body.reason == null ? '' : String(body.reason).trim();
  if (!order_id) return badReq('order_id required', 'ORDER_ID_REQUIRED');
  if (!reasonRaw) return badReq('reason required', 'REASON_REQUIRED');
  const reason = reasonRaw.slice(0, 1000);

  const sb = getSupabase();
  const { data: order, error: loadErr } = await sb
    .from('demand_orders').select('id, status, comments, order_code').eq('id', order_id).maybeSingle();
  if (loadErr) return serverErr('Lookup failed', loadErr.message);
  if (!order) return notFound('Order not found');
  if (!CLOSEABLE_STATUSES.has(order.status)) {
    return conflict(
      `No se puede cerrar un pedido en estado "${order.status}".`,
      'NOT_CLOSEABLE',
    );
  }

  const stamp = new Date().toISOString();
  const author = (session && session.role) ? session.role : 'unknown';
  const tag = `[Cerrado manualmente por ${author} · ${stamp.slice(0, 10)}] ${reason}`;
  const newComments = order.comments ? `${order.comments}\n${tag}` : tag;

  const { data: updated, error: upErr } = await sb
    .from('demand_orders').update({
      status: ORDER_STATUS.Completed,
      completed_at: stamp,
      comments: newComments,
    }).eq('id', order_id).select().single();
  if (upErr) return serverErr('Update failed', upErr.message);

  return ok({ order: updated });
});
