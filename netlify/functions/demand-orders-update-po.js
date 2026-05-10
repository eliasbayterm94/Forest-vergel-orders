'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

const PO_STATUSES = ['Pendiente', 'Emitida', 'Recibida', 'Cancelada'];

/**
 * POST /demand-orders-update-po  (forest, admin)
 * Body: { order_id, external_po_status?, external_po_supplier?,
 *         external_po_code?, external_po_date?, external_po_notes? }
 *
 * Updates the external-PO fields on a demand order. Independent of the
 * order's main status — Forest can update PO state at any time on
 * Rejected or PartiallyAccepted orders (or even on others if relevant).
 *
 * Pass null for any field to clear it. Omit a field to leave unchanged.
 */
exports.handler = requireAuth(['forest', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const order_id = body.order_id;
  if (!order_id) return badReq('order_id required', 'ORDER_ID_REQUIRED');

  const update = {};

  if (body.external_po_status !== undefined) {
    if (body.external_po_status !== null && !PO_STATUSES.includes(body.external_po_status)) {
      return badReq('external_po_status invalid', 'INVALID_STATUS');
    }
    update.external_po_status = body.external_po_status;
  }
  if (body.external_po_supplier !== undefined) {
    update.external_po_supplier = body.external_po_supplier
      ? String(body.external_po_supplier).trim() || null
      : null;
  }
  if (body.external_po_code !== undefined) {
    update.external_po_code = body.external_po_code
      ? String(body.external_po_code).trim() || null
      : null;
  }
  if (body.external_po_date !== undefined) {
    if (body.external_po_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(body.external_po_date || '')) {
      return badReq('external_po_date must be YYYY-MM-DD', 'INVALID_DATE');
    }
    update.external_po_date = body.external_po_date;
  }
  if (body.external_po_notes !== undefined) {
    update.external_po_notes = body.external_po_notes == null ? null : String(body.external_po_notes);
  }

  if (Object.keys(update).length === 0) return badReq('No fields provided', 'NO_FIELDS');

  const sb = getSupabase();
  const { data, error } = await sb
    .from('demand_orders').update(update).eq('id', order_id).select().maybeSingle();
  if (error) return serverErr('Update failed', error.message);
  if (!data) return notFound('Order not found');
  return ok({ order: data });
});
