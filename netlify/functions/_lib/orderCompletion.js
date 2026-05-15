'use strict';

const { LOT_STATUS, ORDER_STATUS } = require('./schema');
const { notifyOrderCompleted } = require('./notifications');

/**
 * Si la suma de asignaciones del pedido provenientes de lotes Delivered
 * cubre el kg_green_accepted, marca el pedido como Completed y dispara
 * la notificación. Idempotente: sólo actúa si el pedido está hoy en
 * InProduction.
 *
 * Returns { order_id, notification } on completion, null otherwise.
 */
async function maybeCompleteOrder(sb, order_id) {
  const { data: order, error } = await sb
    .from('demand_orders')
    .select('*, coffee_references(id,name)')
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

module.exports = { maybeCompleteOrder };
