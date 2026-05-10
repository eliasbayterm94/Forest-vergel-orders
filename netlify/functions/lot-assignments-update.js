'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, notFound, conflict, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /lot-assignments-update  (finca, admin)
 * Body: { assignment_id, kg_green_allocated }
 *
 * Edits the kg of a single assignment. The DB triggers enforce:
 *   - per-order: sum of allocations to one order ≤ kg_green_accepted
 *   - per-lot:   sum of allocations within one lot ≤ kg_green_actual ?? kg_green_expected
 *                (only enforced when increasing the value)
 */
exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const assignment_id = body.assignment_id;
  if (!assignment_id) return badReq('assignment_id required', 'ASSIGNMENT_ID_REQUIRED');
  const kg = Number(body.kg_green_allocated);
  if (!Number.isFinite(kg) || kg <= 0) return badReq('kg_green_allocated must be > 0', 'INVALID_KG');

  const sb = getSupabase();
  const { data, error } = await sb
    .from('lot_order_assignments')
    .update({ kg_green_allocated: kg })
    .eq('id', assignment_id)
    .select()
    .maybeSingle();
  if (error) {
    // Surface the two trigger-level errors with friendlier codes.
    if (/exceed lot capacity/i.test(error.message))           return conflict(error.message, 'LOT_OVER_ALLOCATED');
    if (/exceeds order kg_green_accepted/i.test(error.message)) return conflict(error.message, 'ORDER_OVER_ALLOCATED');
    return serverErr('Update failed', error.message);
  }
  if (!data) return notFound('Assignment not found');
  return ok({ assignment: data });
});
