'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /lot-assignments-delete  (finca, admin)
 * Body: { assignment_id }
 * Used to correct a misallocation before delivery.
 */
exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const assignment_id = body.assignment_id;
  if (!assignment_id) return badReq('assignment_id required', 'ASSIGNMENT_ID_REQUIRED');

  const sb = getSupabase();
  const { data, error } = await sb
    .from('lot_order_assignments').delete().eq('id', assignment_id).select().maybeSingle();
  if (error) return serverErr('Delete failed', error.message);
  if (!data) return notFound('Assignment not found');
  return ok({ deleted: data });
});
