'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { LOT_STATUS, ORDER_STATUS } = require('./_lib/schema');
const { ok, badReq, notFound, conflict, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');
const { notifyOrderCompleted } = require('./_lib/notifications');
const { bogotaToday } = require('./_lib/bogotaTime');

/**
 * POST /shipments-create  (finca, admin)
 * Body:
 *   shipment_code  (optional — server auto-generates DSP-YYYY-NNNN if absent)
 *   shipment_date  'YYYY-MM-DD' (optional — defaults to today Bogota)
 *   notes          string (optional)
 *   lot_ids        [uuid] — Ready lots to include in this shipment (≥1)
 *
 * Effects:
 *   1. Insert shipment row + shipment_lots links.
 *   2. For each lot, transition to Delivered (sets delivered_date).
 *   3. Cascade: any order whose total assigned kg from delivered lots
 *      now meets kg_green_accepted is marked Completed and the
 *      "order_completed" notification fires.
 *
 * Returns: { shipment, completions: [{order_id, notification}] }
 */
exports.handler = requireAuth(['finca', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const lot_ids = Array.isArray(body.lot_ids) ? [...new Set(body.lot_ids.filter(Boolean))] : [];
  if (lot_ids.length === 0) return badReq('lot_ids[] required', 'LOT_IDS_REQUIRED');

  const shipment_code = body.shipment_code ? String(body.shipment_code).trim() : null;
  const shipment_date = body.shipment_date || bogotaToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shipment_date)) return badReq('shipment_date must be YYYY-MM-DD', 'INVALID_DATE');
  const notes = body.notes == null ? null : String(body.notes);

  const sb = getSupabase();

  // Verify all lots exist, are Ready, and not already shipped.
  const { data: lots, error: lErr } = await sb
    .from('production_lots')
    .select('id, lot_code, status, kg_green_actual, kg_green_expected')
    .in('id', lot_ids);
  if (lErr) return serverErr('Lot lookup failed', lErr.message);
  if (!lots || lots.length !== lot_ids.length) {
    return badReq('One or more lots not found', 'LOT_NOT_FOUND');
  }
  const notReady = lots.filter((l) => l.status !== LOT_STATUS.Ready);
  if (notReady.length > 0) {
    return conflict(
      `Lots not in Ready state: ${notReady.map((l) => l.lot_code).join(', ')}`,
      'LOT_NOT_READY',
    );
  }
  const { data: existingLinks, error: exErr } = await sb
    .from('shipment_lots').select('production_lot_id').in('production_lot_id', lot_ids);
  if (exErr) return serverErr('Existing-link lookup failed', exErr.message);
  if (existingLinks && existingLinks.length > 0) {
    const taken = lots.filter((l) => existingLinks.some((x) => x.production_lot_id === l.id));
    return conflict(
      `Lots already in another shipment: ${taken.map((l) => l.lot_code).join(', ')}`,
      'LOT_ALREADY_SHIPPED',
    );
  }

  // Insert shipment
  const { data: ship, error: sErr } = await sb
    .from('shipments').insert({
      shipment_code, shipment_date, notes,
      created_by: session.role,
    }).select().single();
  if (sErr) {
    if (/shipments_shipment_code_key/i.test(sErr.message)) {
      return conflict('shipment_code already exists', 'DUPLICATE_CODE');
    }
    return serverErr('Failed to create shipment', sErr.message);
  }

  // Link lots
  const linkRows = lot_ids.map((lot_id) => ({ shipment_id: ship.id, production_lot_id: lot_id }));
  const { error: linkErr } = await sb.from('shipment_lots').insert(linkRows);
  if (linkErr) {
    await sb.from('shipments').delete().eq('id', ship.id);
    return serverErr('Failed to link lots', linkErr.message);
  }

  // Transition each lot to Delivered, then run order-completion cascade.
  const today = bogotaToday();
  const completions = [];
  for (const lot of lots) {
    const { error: upErr } = await sb
      .from('production_lots')
      .update({ status: LOT_STATUS.Delivered, delivered_date: today })
      .eq('id', lot.id);
    if (upErr) return serverErr(`Failed to deliver lot ${lot.lot_code}`, upErr.message);

    // For each assigned order, check if completion threshold is met.
    const { data: assigns, error: aErr } = await sb
      .from('lot_order_assignments').select('demand_order_id').eq('production_lot_id', lot.id);
    if (aErr) return serverErr('Assignment lookup failed', aErr.message);

    for (const a of assigns || []) {
      const result = await maybeCompleteOrder(sb, a.demand_order_id);
      if (result) completions.push(result);
    }
  }

  return ok({ shipment: ship, completions });
});

async function maybeCompleteOrder(sb, order_id) {
  const { data: order, error } = await sb
    .from('demand_orders')
    .select(`*, coffee_references(id,name)`)
    .eq('id', order_id).maybeSingle();
  if (error || !order) return null;
  if (order.status !== ORDER_STATUS.InProduction) return null;

  // Sum allocations from lots that have been Delivered.
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
