'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ORDER_STATUS } = require('./_lib/schema');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');
const { actorLabel } = require('./_lib/actor');

/**
 * POST /demand-orders-cancel  (forest, finca, admin)
 * Body: { order_id, reason? }
 *
 * Cancela un pedido (soft delete: status = Cancelled). Aplica a
 * estados activos (Pending, Accepted, PartiallyAccepted, InProduction).
 * El trigger en BD permite estas transiciones. Finca puede cancelar
 * desde la Cola de Pedidos; Forest desde su tablero.
 *
 * Si el pedido tiene asignaciones a lotes que aún no se despacharon
 * (status != Delivered), devolvemos 409 HAS_LOT_ASSIGNMENTS con el
 * detalle: el operador debe liberar esas asignaciones desde
 * Producción antes de cancelar (evitamos huérfanos en producción que
 * apuntan a un pedido cancelado).
 */
const ACTIVE_STATUSES = new Set([
  ORDER_STATUS.Pending,
  ORDER_STATUS.Accepted,
  ORDER_STATUS.PartiallyAccepted,
  ORDER_STATUS.InProduction,
]);

exports.handler = requireAuth(['forest', 'finca', 'admin'], async (event, _ctx, session) => {
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
  if (!ACTIVE_STATUSES.has(order.status)) {
    return conflict(
      `No se puede cancelar un pedido en estado "${order.status}".`,
      'NOT_CANCELLABLE',
    );
  }

  // Asignaciones a lotes no-Delivered bloquean la cancelación.
  const { data: assigns, error: aErr } = await sb
    .from('lot_order_assignments')
    .select('id, kg_green_allocated, production_lots(bache_code, lot_code, status)')
    .eq('demand_order_id', order_id);
  if (aErr) return serverErr('Assignment lookup failed', aErr.message);
  const active = (assigns || []).filter((a) => a.production_lots && a.production_lots.status !== 'Delivered');
  if (active.length > 0) {
    return conflict(
      `El pedido tiene ${active.length} asignación(es) a lote(s) activo(s). Quita las asignaciones desde Producción antes de cancelar.`,
      'HAS_LOT_ASSIGNMENTS',
      {
        assignments: active.map((a) => ({
          assignment_id: a.id,
          bache_code:    a.production_lots && (a.production_lots.bache_code || a.production_lots.lot_code),
          status:        a.production_lots && a.production_lots.status,
          kg_green_allocated: Number(a.kg_green_allocated || 0),
        })),
      },
    );
  }

  // Append reason to comments so we keep an audit trail (con rol y
  // operario para saber QUIÉN canceló — mismo formato que el cierre
  // manual de pedidos).
  const stamp = new Date().toISOString().slice(0, 10);
  const author = actorLabel(session, body);
  const tag = `[Cancelado por ${author} · ${stamp}]${reason ? ` ${reason}` : ''}`;
  const newComments = [order.comments, tag].filter(Boolean).join('\n');

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
