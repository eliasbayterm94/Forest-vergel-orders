'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { LOT_STATUS } = require('./_lib/schema');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /lot-partials-reject  (finca, admin)
 * Body:
 *   partial_id   uuid
 *   reason       string (optional)
 *   undo         boolean (optional) — clears rejection
 *
 * Reglas:
 *   • Solo se puede rechazar (o deshacer) cuando el lote esta en Ready.
 *   • Un parcial ya despachado no puede rechazarse.
 */
exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const partial_id = body.partial_id;
  const undo = body.undo === true;
  const reason = body.reason == null ? null : String(body.reason);
  if (!partial_id) return badReq('partial_id required', 'PARTIAL_ID_REQUIRED');

  const sb = getSupabase();
  const { data: row, error: loadErr } = await sb
    .from('lot_partials')
    .select('id, parcial_letter, rejected_at, production_lots!inner(status)')
    .eq('id', partial_id).maybeSingle();
  if (loadErr) return serverErr('Lookup failed', loadErr.message);
  if (!row) return notFound('Partial not found');
  if (row.production_lots.status !== LOT_STATUS.Ready) {
    return conflict('Solo se pueden rechazar parciales mientras el lote esta en Ready', 'INVALID_LOT_STATUS');
  }

  // Cannot reject something already shipped.
  const { data: shipLink } = await sb
    .from('shipment_lots').select('shipment_id').eq('lot_partial_id', partial_id).maybeSingle();
  if (shipLink) {
    return conflict('Este parcial ya esta en un despacho', 'PARTIAL_ALREADY_SHIPPED');
  }

  const update = undo
    ? { rejected_at: null, rejection_reason: null }
    : { rejected_at: new Date().toISOString(), rejection_reason: reason };

  const { data: upd, error: upErr } = await sb
    .from('lot_partials').update(update).eq('id', partial_id).select().single();
  if (upErr) return serverErr('Update failed', upErr.message);

  return ok({ partial: upd });
});
