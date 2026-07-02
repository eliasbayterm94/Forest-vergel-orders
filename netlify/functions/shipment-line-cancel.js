'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');
const {
  revertLotsIfNotStillDelivered,
  revertOrdersIfNoLongerComplete,
} = require('./_lib/shipmentRevert');
const { actorLabel } = require('./_lib/actor');

/**
 * POST /shipment-line-cancel  (finca, admin)
 * Body: { shipment_id, production_lot_id, reason? }
 *
 * Cancela SÓLO la línea de un bache dentro de un despacho. Borra
 * todas las filas shipment_lots para ese (shipment, production_lot)
 * — cubre tanto whole-lot como cada parcial — y luego:
 *
 *   1) Si el bache estaba Delivered y ningún otro shipment vivo lo
 *      mantiene, vuelve a Ready y se le limpia delivered_date.
 *   2) Las órdenes Completed que ya no cumplan el threshold por
 *      kg_green_accepted vuelven a InProduction.
 *   3) Si el shipment queda sin filas en shipment_lots, se borra
 *      la fila shipments también.
 */
exports.handler = requireAuth(['finca', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const shipment_id = body.shipment_id;
  const production_lot_id = body.production_lot_id;
  const reason = body.reason == null ? null : String(body.reason).trim().slice(0, 500);
  if (!shipment_id) return badReq('shipment_id required', 'SHIPMENT_ID_REQUIRED');
  if (!production_lot_id) return badReq('production_lot_id required', 'LOT_ID_REQUIRED');

  const sb = getSupabase();

  // Validar que el shipment existe y tiene esa línea.
  const { data: ship, error: sErr } = await sb
    .from('shipments')
    .select('id, shipment_code, notes')
    .eq('id', shipment_id).maybeSingle();
  if (sErr) return serverErr('Lookup failed', sErr.message);
  if (!ship) return notFound('Shipment not found');

  const { data: linesToRemove, error: lErr } = await sb
    .from('shipment_lots')
    .select('id')
    .eq('shipment_id', shipment_id)
    .eq('production_lot_id', production_lot_id);
  if (lErr) return serverErr('Line lookup failed', lErr.message);
  if (!linesToRemove || linesToRemove.length === 0) {
    return notFound('Lot not present in this shipment');
  }

  const { error: delErr } = await sb
    .from('shipment_lots')
    .delete()
    .eq('shipment_id', shipment_id)
    .eq('production_lot_id', production_lot_id);
  if (delErr) return serverErr('Failed to remove shipment line', delErr.message);

  // Apéndice del motivo en notes (no destructivo).
  if (reason) {
    const author = actorLabel(session, body);
    const stamp = new Date().toISOString().slice(0, 10);
    const tag = `[Línea cancelada · ${author} · ${stamp}] (${production_lot_id.slice(0, 8)}): ${reason}`;
    const newNotes = ship.notes ? `${ship.notes} · ${tag}` : tag;
    await sb.from('shipments').update({ notes: newNotes }).eq('id', shipment_id);
  }

  let revertedLot = null;
  let revertedOrders = [];
  try {
    const reverted = await revertLotsIfNotStillDelivered(sb, [production_lot_id]);
    if (reverted.length > 0) revertedLot = reverted[0];
    revertedOrders = await revertOrdersIfNoLongerComplete(sb, reverted);
  } catch (e) {
    return serverErr('Cascade failed', e.message);
  }

  // Si el despacho quedó sin líneas, lo borramos.
  const { count: remainingCount, error: rErr } = await sb
    .from('shipment_lots').select('id', { count: 'exact', head: true })
    .eq('shipment_id', shipment_id);
  if (rErr) return serverErr('Remaining lookup failed', rErr.message);
  let shipmentDeleted = false;
  if ((remainingCount || 0) === 0) {
    const { error: delShipErr } = await sb.from('shipments').delete().eq('id', shipment_id);
    if (delShipErr) return serverErr('Failed to delete empty shipment', delShipErr.message);
    shipmentDeleted = true;
  }

  return ok({
    cancelled: {
      shipment_id,
      shipment_code: ship.shipment_code,
      production_lot_id,
      lot_reverted_to_ready: revertedLot,
      orders_reverted_to_in_production: revertedOrders,
      shipment_deleted: shipmentDeleted,
    },
  });
});
