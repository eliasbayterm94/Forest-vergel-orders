'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /lot-purchases-delete  (finca, admin)
 * Body: { purchase_id }
 */
exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const purchase_id = body.purchase_id;
  if (!purchase_id) return badReq('purchase_id required', 'PURCHASE_ID_REQUIRED');

  const sb = getSupabase();
  const { error } = await sb.from('lot_purchases').delete().eq('id', purchase_id);
  if (error) return serverErr('Delete failed', error.message);
  return ok({ deleted: purchase_id });
});
