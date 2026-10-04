'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { CLEAR_DELTA, deliveredKgFor, planDelta } = require('./_lib/orderKgChange');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /demand-orders-resolve-kg-change  (finca, admin)
 * Body: { order_id, accept: boolean, reason? }
 *
 * La finca resuelve el ajuste de cantidad que pidió Forest.
 *
 * Al ACEPTAR, kg_green_required y kg_green_accepted se mueven JUNTOS
 * en un solo update. Eso es lo que mantiene viva la constraint
 * chk_status_consistency (migración 0002) sin tocar el estado del
 * pedido: Accepted sigue con required = accepted, PartiallyAccepted
 * sigue con accepted < required, e InProduction no tiene restricción.
 *
 * Se revalida contra los kg ya despachados: entre el momento en que
 * Forest pidió el ajuste y este, pueden haber salido baches, y una
 * reducción que antes era válida puede haber dejado de serlo.
 *
 * Al RECHAZAR solo se limpia la solicitud; el pedido no cambia.
 */
exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const order_id = body && body.order_id;
  if (!order_id) return badReq('order_id required', 'ORDER_ID_REQUIRED');
  if (typeof (body && body.accept) !== 'boolean') {
    return badReq('accept (true/false) requerido', 'ACCEPT_REQUIRED');
  }
  const accept = body.accept;

  const sb = getSupabase();

  const { data: order, error: loadErr } = await sb
    .from('demand_orders')
    .select('id, order_code, status, kg_green_required, kg_green_accepted, kg_green_pending_delta')
    .eq('id', order_id).maybeSingle();
  if (loadErr) return serverErr('Lookup failed', loadErr.message);
  if (!order) return notFound('Order not found');

  if (order.kg_green_pending_delta == null) {
    return conflict(
      'Este pedido no tiene ningún ajuste de cantidad pendiente.',
      'NO_PENDING_DELTA',
    );
  }

  const delta = Number(order.kg_green_pending_delta);

  // Rechazar: limpiar y listo.
  if (!accept) {
    const { data: updated, error: upErr } = await sb
      .from('demand_orders').update(CLEAR_DELTA).eq('id', order_id)
      .select('*').single();
    if (upErr) return serverErr('Update failed', upErr.message);
    return ok({
      order: updated,
      accepted: false,
      delta_kg: delta,
      message: `Ajuste rechazado. El pedido ${order.order_code} queda en ${order.kg_green_required} kg.`,
    });
  }

  // Aceptar: revalidar contra lo despachado HOY, no contra lo que
  // había cuando Forest pidió el ajuste.
  let deliveredKg = 0;
  try { deliveredKg = await deliveredKgFor(sb, order_id); }
  catch (e) { return serverErr('Delivered lookup failed', e.message); }

  const plan = planDelta(order, delta, deliveredKg);
  if (!plan.ok) {
    // La solicitud quedó obsoleta: se limpia para que no se quede
    // atascada, y el mensaje dice por qué.
    const { error: clearErr } = await sb
      .from('demand_orders').update(CLEAR_DELTA).eq('id', order_id);
    if (clearErr) return serverErr('Update failed', clearErr.message);
    return conflict(
      `${plan.message} La solicitud se descartó; pídele a Forest que la vuelva a enviar con el monto correcto.`,
      'DELTA_NO_LONGER_VALID',
    );
  }

  const { data: updated, error: upErr } = await sb
    .from('demand_orders')
    .update({ ...plan.next, ...CLEAR_DELTA })
    .eq('id', order_id)
    .select('*').single();
  if (upErr) return serverErr('Update failed', upErr.message);

  const verb = delta > 0 ? 'añadidos' : 'retirados';
  return ok({
    order: updated,
    accepted: true,
    delta_kg: delta,
    message: `${Math.abs(delta)} kg ${verb}. El pedido ${order.order_code} queda en `
           + `${plan.next.kg_green_required} kg y producción ya trabaja contra ese objetivo.`,
  });
});
