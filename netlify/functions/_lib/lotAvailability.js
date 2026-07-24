'use strict';

const {
  sumBlendedKg, sumShippedFromLinks, sumAllocatedGreen,
  driedLedger, greenLedger, round2,
} = require('./lotInventory');

/**
 * Calcula el verde disponible "neto real" de un lote, descontando:
 *   - asignaciones a pedidos (lot_order_assignments)
 *   - compras en finca (lot_purchases)
 *   - kg seco ya despachado y usado en mezclas, convertido a verde
 *     con el ratio del lote (verde_total / seco_total).
 *
 * La matemática vive en _lib/lotInventory.js (fuente única); aquí
 * solo se hacen las queries y se delega.
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

  const [{ data: assigns }, { data: purchases }, { data: blendUse }, { data: shipLinks }] =
    await Promise.all([
      sb.from('lot_order_assignments').select('kg_green_allocated').eq('production_lot_id', lotId),
      sb.from('lot_purchases').select('kg_green_allocated').eq('production_lot_id', lotId),
      sb.from('lot_blend_components').select('kg_dried_used').eq('source_lot_id', lotId),
      sb.from('shipment_lots').select('kg_dried_shipped, kg_dried_merma, lot_partial_id, lot_partials(kg_dried)')
        .eq('production_lot_id', lotId),
    ]);

  const dl = driedLedger({
    kgDriedOutput: lot.kg_dried_output,
    blendedKg: sumBlendedKg(blendUse),
    // Todos los links (whole y por parcial) vienen en shipLinks; el
    // sumador resuelve kg_dried_shipped ?? kg del parcial embebido.
    shippedWholeKg: sumShippedFromLinks(shipLinks),
  });
  const gl = greenLedger({
    kgGreenActual: lot.kg_green_actual,
    kgGreenExpected: lot.kg_green_expected,
    kgDriedOutput: lot.kg_dried_output,
    driedOutKg: dl.out,
    assignedOrdersKg: sumAllocatedGreen(assigns),
    assignedPurchasesKg: sumAllocatedGreen(purchases),
  });

  return {
    totalGreen: round2(gl.totalGreen),
    assignedOrders: round2(gl.assignedOrders),
    assignedPurchases: round2(gl.assignedPurchases),
    greenGone: round2(gl.greenGone),
    available: round2(gl.available),
  };
}

module.exports = { computeGreenAvailability };
