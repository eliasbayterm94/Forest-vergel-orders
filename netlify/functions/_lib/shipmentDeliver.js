'use strict';

const { LOT_STATUS, ORDER_STATUS } = require('./schema');
const { notifyOrderCompleted } = require('./notifications');
const { driedLedger } = require('./lotInventory');

/**
 * Cascada de ENTREGA de un despacho confirmado — fuente única
 * compartida por shipments-create (camino confirmado) y
 * shipments-confirm (borrador → confirmado).
 *
 * Para cada bache tocado decide si ya salió por completo y, de ser
 * así, lo marca Delivered y dispara la finalización de los pedidos
 * cuyas asignaciones ya están todas entregadas.
 *
 * Recibe TODO precomputado por el caller (no re-consulta inventario)
 * para preservar exactamente el comportamiento probado de create:
 *
 * @param {object} sb                       cliente supabase
 * @param {object} p
 * @param {Array}  p.lots                    [{id, bache_code, lot_code, kg_dried_output, notes, lot_partials:[{id,rejected_at}]}]
 * @param {string} p.today                   YYYY-MM-DD (delivered_date)
 * @param {Map}    p.blendedByLot            lotId → kg seco en mezclas
 * @param {Map}    p.priorShippedWholeByLot  lotId → kg (whole+merma) ya CONFIRMADO antes de este lote
 * @param {Map}    p.newlyShippedWholeByLot  lotId → kg (whole+merma) confirmado en esta operación
 * @param {Set}    p.priorShippedPartialIds  parciales ya confirmados-despachados antes
 * @param {Set}    p.newlyShippedPartialIds  parciales confirmados en esta operación
 * @param {Set}    [p.forceDeliverLots]      baches que deben cerrar sí o sí (peso real total)
 * @param {Map}    [p.notesByLot]            lotId → línea de bitácora a anexar
 * @returns {Promise<{delivered:string[], completions:object[]}>}
 */
async function applyDeliveryAndCompletion(sb, {
  lots, today,
  blendedByLot = new Map(),
  priorShippedWholeByLot = new Map(),
  newlyShippedWholeByLot = new Map(),
  priorShippedPartialIds = new Set(),
  newlyShippedPartialIds = new Set(),
  forceDeliverLots = new Set(),
  notesByLot = new Map(),
}) {
  const completions = [];
  const delivered = [];

  for (const lot of lots) {
    const lotId = lot.id;
    const partials = lot.lot_partials || [];

    let shouldDeliver = false;
    if (partials.length === 0) {
      const shippedTotal = (priorShippedWholeByLot.get(lotId) || 0)
        + (newlyShippedWholeByLot.get(lotId) || 0);
      const remaining = driedLedger({
        kgDriedOutput: lot.kg_dried_output,
        blendedKg: blendedByLot.get(lotId) || 0,
        shippedWholeKg: shippedTotal,
      }).available;
      shouldDeliver = remaining <= 0.01 || forceDeliverLots.has(lotId);
    } else {
      shouldDeliver = partials.every((p) =>
        p.rejected_at != null ||
        priorShippedPartialIds.has(p.id) ||
        newlyShippedPartialIds.has(p.id));
    }

    if (!shouldDeliver) continue;

    const update = { status: LOT_STATUS.Delivered, delivered_date: today };
    const note = notesByLot.get(lotId);
    if (note) update.notes = lot.notes ? `${lot.notes}\n${note}` : note;

    const { error: upErr } = await sb
      .from('production_lots').update(update).eq('id', lotId);
    if (upErr) throw new Error(`Failed to deliver lot ${lot.bache_code || lot.lot_code}: ${upErr.message}`);
    delivered.push(lotId);

    const { data: assigns, error: aErr } = await sb
      .from('lot_order_assignments').select('demand_order_id').eq('production_lot_id', lotId);
    if (aErr) throw new Error(`Assignment lookup failed: ${aErr.message}`);
    for (const a of assigns || []) {
      const result = await maybeCompleteOrder(sb, a.demand_order_id);
      if (result) completions.push(result);
    }
  }

  return { delivered, completions };
}

/**
 * Completa un pedido si todas sus asignaciones ya están entregadas.
 * (Movido aquí desde shipments-create para compartirlo con confirm.)
 */
async function maybeCompleteOrder(sb, order_id) {
  const { data: order, error } = await sb
    .from('demand_orders')
    .select(`*, coffee_references(id,name)`)
    .eq('id', order_id).maybeSingle();
  if (error || !order) return null;
  if (order.status !== ORDER_STATUS.InProduction) return null;

  const { data: delivered, error: dErr } = await sb
    .from('lot_order_assignments')
    .select('kg_green_allocated, production_lots!inner(status)')
    .eq('demand_order_id', order_id)
    .eq('production_lots.status', LOT_STATUS.Delivered);
  if (dErr) return null;

  const totalDelivered = (delivered || []).reduce((s, r) => s + Number(r.kg_green_allocated || 0), 0);
  if (totalDelivered + 1e-6 < Number(order.kg_green_accepted)) return null;

  const { data: completed, error: upErr } = await sb
    .from('demand_orders').update({
      status: ORDER_STATUS.Completed,
      completed_at: new Date().toISOString(),
    }).eq('id', order_id).select().single();
  if (upErr) return null;

  const ref = order.coffee_references || { name: '' };
  const notif = await notifyOrderCompleted(completed, ref);
  return { order_id, notification: notif };
}

module.exports = { applyDeliveryAndCompletion, maybeCompleteOrder };
