'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');
const {
  revertLotsIfNotStillDelivered,
  revertOrdersIfNoLongerComplete,
} = require('./_lib/shipmentRevert');

/**
 * POST /shipments-cancel  (finca, admin)
 * Body: { shipment_id, reason? }
 *
 * Revierte un despacho COMPLETO:
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

  const { data: ship, error: sErr } = await sb
    .from('shipments')
    .select('id, shipment_code, shipment_date, shipment_lots(id, production_lot_id, lot_partial_id)')
    .eq('id', shipment_id).maybeSingle();
  if (sErr) return serverErr('Lookup failed', sErr.message);
  if (!ship) return notFound('Shipment not found');

  const links = ship.shipment_lots || [];
  const lotIds = [...new Set(links.map((l) => l.production_lot_id))];

  const { error: delLinksErr } = await sb
    .from('shipment_lots').delete().eq('shipment_id', shipment_id);
  if (delLinksErr) return serverErr('Failed to remove shipment_lots', delLinksErr.message);

  let lotsRevertedToReady = [];
  let ordersReverted = [];
  try {
    lotsRevertedToReady = await revertLotsIfNotStillDelivered(sb, lotIds);
    ordersReverted = await revertOrdersIfNoLongerComplete(sb, lotsRevertedToReady);
  } catch (e) {
    return serverErr('Cascade failed', e.message);
  }

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
