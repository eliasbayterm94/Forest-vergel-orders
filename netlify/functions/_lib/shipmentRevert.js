'use strict';

const { LOT_STATUS, ORDER_STATUS } = require('./schema');

/**
 * Revierte lots Delivered de vuelta a Ready si ningún otro shipment
 * sigue "completándolos". Para cada lot:
 *   - whole-lot en otro shipment vivo → sigue Delivered
 *   - parciales: si TODOS sus partials siguen shipped/rejected en
 *     otros shipments → sigue Delivered
 *   - en otro caso → vuelve a Ready, limpia delivered_date
 *
 * @returns {Promise<string[]>} ids de lots revertidos
 */
async function revertLotsIfNotStillDelivered(sb, lotIds) {
  const reverted = [];
  for (const lotId of lotIds) {
    const { data: lot, error: lErr } = await sb
      .from('production_lots')
      .select('id, status, lot_partials(id, rejected_at)')
      .eq('id', lotId).maybeSingle();
    if (lErr) throw new Error('Lot lookup failed: ' + lErr.message);
    if (!lot || lot.status !== LOT_STATUS.Delivered) continue;

    const { data: stillLinked, error: linkErr } = await sb
      .from('shipment_lots').select('id, lot_partial_id').eq('production_lot_id', lotId);
    if (linkErr) throw new Error('Link lookup failed: ' + linkErr.message);

    let stillDelivered = false;
    const stillHasWholeLot = (stillLinked || []).some((x) => x.lot_partial_id == null);
    if (stillHasWholeLot) {
      stillDelivered = true;
    } else if ((lot.lot_partials || []).length > 0) {
      const remainingShipped = new Set((stillLinked || []).map((x) => x.lot_partial_id).filter(Boolean));
      stillDelivered = (lot.lot_partials || []).every((p) =>
        p.rejected_at != null || remainingShipped.has(p.id));
    }

    if (!stillDelivered) {
      const { error: upErr } = await sb
        .from('production_lots')
        .update({ status: LOT_STATUS.Ready, delivered_date: null })
        .eq('id', lotId);
      if (upErr) throw new Error('Failed to revert lot: ' + upErr.message);
      reverted.push(lotId);
    }
  }
  return reverted;
}

/**
 * Para los lots revertidos a Ready, busca órdenes que estén
 * Completed y ya no cumplan el threshold de kg_green_accepted. Las
 * devuelve a InProduction.
 *
 * @returns {Promise<string[]>} ids de órdenes revertidas
 */
async function revertOrdersIfNoLongerComplete(sb, lotIds) {
  if (lotIds.length === 0) return [];
  const { data: assignsAffected, error: aErr } = await sb
    .from('lot_order_assignments')
    .select('demand_order_id')
    .in('production_lot_id', lotIds);
  if (aErr) throw new Error('Assignment lookup failed: ' + aErr.message);

  const orderIds = [...new Set((assignsAffected || []).map((a) => a.demand_order_id))];
  const reverted = [];
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
      reverted.push(orderId);
    }
  }
  return reverted;
}

module.exports = {
  revertLotsIfNotStillDelivered,
  revertOrdersIfNoLongerComplete,
};
