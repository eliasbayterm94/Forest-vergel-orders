'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ORDER_STATUS } = require('./_lib/schema');
const { validateDelta, deliveredKgFor, planDelta } = require('./_lib/orderKgChange');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /demand-orders-request-kg-change  (forest, admin)
 * Body: { order_id, delta_kg, reason? }
 *
 * Forest pide añadir (+) o quitar (-) kg verde de un pedido.
 *
 * Pedidos Pending: se aplica DIRECTO. Nadie aceptó todavía
 * (kg_green_accepted IS NULL) y el pedido sigue en el inbox de la
 * finca, así que no hay nada que renegociar.
 *
 * Pedidos Accepted / PartiallyAccepted / InProduction: se guarda como
 * SOLICITUD. La finca la acepta o la rechaza en
 * /demand-orders-resolve-kg-change. Hasta entonces kg_green_required y
 * kg_green_accepted no se mueven, así que producción sigue trabajando
 * contra el compromiso vigente.
 *
 * Una solicitud nueva reemplaza la anterior si todavía no se resolvió
 * — Forest puede corregir lo que pidió sin pedirle a la finca que
 * rechace primero.
 */
const ACTIVE_STATUSES = new Set([
  ORDER_STATUS.Pending,
  ORDER_STATUS.Accepted,
  ORDER_STATUS.PartiallyAccepted,
  ORDER_STATUS.InProduction,
]);

exports.handler = requireAuth(['forest', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const order_id = body && body.order_id;
  if (!order_id) return badReq('order_id required', 'ORDER_ID_REQUIRED');

  const d = validateDelta(body && body.delta_kg);
  if (!d.ok) return badReq(d.message, d.code);

  const reason = body && body.reason != null
    ? String(body.reason).trim().slice(0, 500) || null
    : null;

  const sb = getSupabase();

  const { data: order, error: loadErr } = await sb
    .from('demand_orders')
    .select('id, order_code, status, kg_green_required, kg_green_accepted')
    .eq('id', order_id).maybeSingle();
  if (loadErr) return serverErr('Lookup failed', loadErr.message);
  if (!order) return notFound('Order not found');

  if (!ACTIVE_STATUSES.has(order.status)) {
    return conflict(
      `No se puede ajustar la cantidad de un pedido en estado "${order.status}".`,
      'NOT_ADJUSTABLE',
    );
  }

  let deliveredKg = 0;
  try { deliveredKg = await deliveredKgFor(sb, order_id); }
  catch (e) { return serverErr('Delivered lookup failed', e.message); }

  const plan = planDelta(order, d.value, deliveredKg);
  if (!plan.ok) return badReq(plan.message, plan.code);

  // Pending → aplicar directo, sin solicitud.
  if (order.status === ORDER_STATUS.Pending) {
    const { data: updated, error: upErr } = await sb
      .from('demand_orders')
      .update({ kg_green_required: plan.next.kg_green_required })
      .eq('id', order_id)
      .select('*').single();
    if (upErr) return serverErr('Update failed', upErr.message);
    return ok({
      order: updated,
      applied: true,
      delta_kg: d.value,
      message: `Pedido ${order.order_code} actualizado a ${plan.next.kg_green_required} kg. `
             + 'El pedido todavía está pendiente de revisión por la finca.',
    });
  }

  // Resto → guardar la solicitud para que la finca la resuelva.
  const { data: updated, error: upErr } = await sb
    .from('demand_orders')
    .update({
      kg_green_pending_delta:     d.value,
      pending_delta_reason:       reason,
      pending_delta_requested_at: new Date().toISOString(),
      pending_delta_requested_by: (session && (session.username || session.role)) || null,
    })
    .eq('id', order_id)
    .select('*').single();
  if (upErr) return serverErr('Update failed', upErr.message);

  const verb = d.value > 0 ? 'añadir' : 'quitar';
  return ok({
    order: updated,
    applied: false,
    delta_kg: d.value,
    message: `Solicitud enviada: ${verb} ${Math.abs(d.value)} kg al pedido ${order.order_code}. `
           + 'Queda pendiente de que la finca la acepte.',
  });
});
