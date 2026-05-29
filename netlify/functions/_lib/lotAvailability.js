'use strict';

/**
 * Calcula el verde disponible "neto real" de un lote, descontando:
 *   - asignaciones a pedidos (lot_order_assignments)
 *   - compras en finca (lot_purchases)
 *   - kg seco ya despachado y usado en mezclas, convertido a verde
 *     con el ratio del lote (verde_total / seco_total).
 *
 * @returns {Promise<{
 *   totalGreen:number, assignedOrders:number, assignedPurchases:number,
 *   greenGone:number, available:number
 * }>}
 */
async function computeGreenAvailability(sb, lotId) {
  const { data: lot, error } = await sb
    .from('production_lots')
    .select('id, kg_green_actual, kg_green_expected, kg_dried_output')
    .eq('id', lotId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!lot) throw new Error('Lot not found');

  const totalGreen = Number(lot.kg_green_actual ?? lot.kg_green_expected ?? 0);
  const totalDried = Number(lot.kg_dried_output ?? 0);
  const greenPerDried = totalDried > 0 ? totalGreen / totalDried : 0;

  const [{ data: assigns }, { data: purchases }, { data: blendUse }, { data: shipLinks }] =
    await Promise.all([
      sb.from('lot_order_assignments').select('kg_green_allocated').eq('production_lot_id', lotId),
      sb.from('lot_purchases').select('kg_green_allocated').eq('production_lot_id', lotId),
      sb.from('lot_blend_components').select('kg_dried_used').eq('source_lot_id', lotId),
      sb.from('shipment_lots').select('kg_dried_shipped, lot_partial_id, lot_partials(kg_dried)')
        .eq('production_lot_id', lotId),
    ]);

  const assignedOrders = (assigns || []).reduce((s, r) => s + Number(r.kg_green_allocated || 0), 0);
  const assignedPurchases = (purchases || []).reduce((s, r) => s + Number(r.kg_green_allocated || 0), 0);

  const blendedDried = (blendUse || []).reduce((s, r) => s + Number(r.kg_dried_used || 0), 0);
  const shippedDried = (shipLinks || []).reduce((s, r) => {
    if (r.kg_dried_shipped != null) return s + Number(r.kg_dried_shipped);
    if (r.lot_partials && r.lot_partials.kg_dried != null) return s + Number(r.lot_partials.kg_dried);
    return s;
  }, 0);

  const greenGone = (blendedDried + shippedDried) * greenPerDried;
  const available = Math.max(0,
    totalGreen - greenGone - assignedOrders - assignedPurchases);

  return {
    totalGreen: round2(totalGreen),
    assignedOrders: round2(assignedOrders),
    assignedPurchases: round2(assignedPurchases),
    greenGone: round2(greenGone),
    available: round2(available),
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { computeGreenAvailability };
