'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { LOT_STATUS } = require('./_lib/schema');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /lot-partials-delete  (finca, admin)
 * Body: { partial_id }
 *
 * Solo se puede borrar mientras el lote padre sigue en Drying.
 */
exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const partial_id = body.partial_id;
  if (!partial_id) return badReq('partial_id required', 'PARTIAL_ID_REQUIRED');

  const sb = getSupabase();
  const { data: row, error: loadErr } = await sb
    .from('lot_partials')
    .select('id, production_lot_id, production_lots!inner(status)')
    .eq('id', partial_id).maybeSingle();
  if (loadErr) return serverErr('Lookup failed', loadErr.message);
  if (!row) return notFound('Partial not found');
  if (row.production_lots.status !== LOT_STATUS.Drying) {
    return conflict('Solo se pueden borrar parciales mientras el lote esta en Drying', 'INVALID_LOT_STATUS');
  }

  const { error: delErr } = await sb.from('lot_partials').delete().eq('id', partial_id);
  if (delErr) return serverErr('Delete failed', delErr.message);
  return ok({ deleted: true });
});
