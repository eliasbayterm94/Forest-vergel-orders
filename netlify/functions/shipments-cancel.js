'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { LOT_STATUS, ORDER_STATUS } = require('./_lib/schema');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /shipments-cancel  (finca, admin)
 * Body: { shipment_id, reason? }
 *
 * Revierte un despacho:
 *   1) Borra los shipment_lots (libera lots/partials para volver a despachar).
 *   2) Cada lot que paso a Delivered POR ESTE despacho vuelve a Ready y se
 *      le borra delivered_date. Si el lot esta en Delivered pero esta tambien
 *      enlazado a otro shipment vivo, se deja como esta.
 *   3) Cada pedido que se completo (status Completed) por las allocaciones
 *      de los lots devueltos a Ready se devuelve a InProduction y se borra
 *      completed_at.
 *   4) Borra la fila shipments.
 *
 * Idempotente: borrar dos veces el mismo shipment devuelve 404.
 */
exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const shipment_id = body.shipment_id;
  if (!shipment_id) return badReq('shipment_id required', 'SHIPMENT_ID_REQUIRED');

  const sb = getSupabase();

  // 0) Cargar el despacho con sus links.
  const { data: ship, error: sErr } = await sb
    .from('shipments')
    .select('id, shipment_code, shipment_date, shipment_lots(id, production_lot_id, lot_partial_id)')
    .eq('id', shipment_id).maybeSingle();
  if (sErr) return serverErr('Lookup failed', sErr.message);
  if (!ship) return notFound('Shipment not found');

  const links = ship.shipment_lots || [];
  const lotIds = [...new Set(links.map((l) => l.production_lot_id))];

  // 1) Borrar links primero. Si falla, abortamos antes de tocar status.
  const { error: delLinksErr } = await sb
    .from('shipment_lots').delete().eq('shipment_id', shipment_id);
  if (delLinksErr) return serverErr('Failed to remove shipment_lots', delLinksErr.message);

  // 2) Para cada lot: si quedaba Delivered y ya no tiene OTRO shipment vivo
  //    que lo "complete" (whole-lot link, o todos sus partials shipped/rejected),
  //    devolverlo a Ready.
  const lotsRevertedToReady = [];
  for (const lotId of lotIds) {
    const { data: lot, error: lErr } = await sb
      .from('production_lots')
      .select('id, status, lot_partials(id, rejected_at)')
      .eq('id', lotId).maybeSingle();
    if (lErr) return serverErr('Lot lookup failed', lErr.message);
    if (!lot || lot.status !== LOT_STATUS.Delivered) continue;

    // Verificar si OTRO shipment todavia "completa" el lot
    const { data: stillLinked, error: linkErr } = await sb
      .from('shipment_lots').select('id, lot_partial_id').eq('production_lot_id', lotId);
    if (linkErr) return serverErr('Link lookup failed', linkErr.message);

    let stillDelivered = false;
    const stillHasWholeLot = (stillLinked || []).some((x) => x.lot_partial_id == null);
    if (stillHasWholeLot) {
      stillDelivered = true;
    } else if ((lot.lot_partials || []).length > 0) {
      // Modo parcial: sigue Delivered si TODOS los partials estan rejected o shipped en otro despacho
      const remainingShipped = new Set((stillLinked || []).map((x) => x.lot_partial_id).filter(Boolean));
      stillDelivered = (lot.lot_partials || []).every((p) =>
        p.rejected_at != null || remainingShipped.has(p.id));
    }

    if (!stillDelivered) {
      const { error: upErr } = await sb
        .from('production_lots')
        .update({ status: LOT_STATUS.Ready, delivered_date: null })
        .eq('id', lotId);
      if (upErr) return serverErr('Failed to revert lot', upErr.message);
      lotsRevertedToReady.push(lotId);
    }
  }

  // 3) Re-evaluar pedidos completados que dependian de los lots devueltos.
  //    Mismo criterio que maybeCompleteOrder pero a la inversa: si un pedido
  //    Completed ya no tiene total_delivered >= kg_green_accepted, vuelve a
  //    InProduction.
  const ordersReverted = [];
  if (lotsRevertedToReady.length > 0) {
    // Pedidos que tenian al menos un lot que se revirtió.
    const { data: assignsAffected, error: aErr } = await sb
      .from('lot_order_assignments')
      .select('demand_order_id')
      .in('production_lot_id', lotsRevertedToReady);
    if (aErr) return serverErr('Assignment lookup failed', aErr.message);

    const orderIds = [...new Set((assignsAffected || []).map((a) => a.demand_order_id))];
    for (const orderId of orderIds) {
      const { data: o } = await sb
        .from('demand_orders').select('id, status, kg_green_accepted').eq('id', orderId).maybeSingle();
      if (!o || o.status !== ORDER_STATUS.Completed) continue;

      const { data: deliveredAssigns } = await sb
        .from('lot_order_assignments')
        .select('kg_green_allocated, production_lots!inner(status)')
        .eq('demand_order_id', orderId)
        .eq('production_lots.status', LOT_STATUS.Delivered);
      const totalDelivered = (deliveredAssigns || []).reduce(
        (s, r) => s + Number(r.kg_green_allocated || 0), 0);

      if (totalDelivered + 1e-6 < Number(o.kg_green_accepted)) {
        await sb.from('demand_orders').update({
          status: ORDER_STATUS.InProduction,
          completed_at: null,
        }).eq('id', orderId);
        ordersReverted.push(orderId);
      }
    }
  }

  // 4) Borrar el despacho.
  const { error: delShipErr } = await sb.from('shipments').delete().eq('id', shipment_id);
  if (delShipErr) return serverErr('Failed to delete shipment', delShipErr.message);

  return ok({
    cancelled: {
      shipment_id,
      shipment_code: ship.shipment_code,
      lots_reverted_to_ready: lotsRevertedToReady,
      orders_reverted_to_in_production: ordersReverted,
    },
  });
});
