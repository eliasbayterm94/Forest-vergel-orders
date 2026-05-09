'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ORDER_STATUS } = require('./_lib/schema');
const { ok, created, badReq, serverErr, conflict, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /lot-assignments-create  (finca, admin)
 * Body:
 *   production_lot_id   uuid
 *   assignments         [{ demand_order_id, kg_green_allocated }]
 *
 * The DB trigger enforces:
 *   - reference_id match between lot & order
 *   - process_type match
 *   - sum of allocations per order ≤ order.kg_green_accepted
 *
 * Side effect: any Accepted/PartiallyAccepted order touched is promoted
 * to InProduction.
 */
exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const production_lot_id = body.production_lot_id;
  const assignments = Array.isArray(body.assignments) ? body.assignments : [];
  if (!production_lot_id) return badReq('production_lot_id required', 'LOT_ID_REQUIRED');
  if (assignments.length === 0) return badReq('assignments[] required', 'ASSIGNMENTS_REQUIRED');

  for (const a of assignments) {
    if (!a.demand_order_id) return badReq('assignments[].demand_order_id required', 'ORDER_ID_REQUIRED');
    const n = Number(a.kg_green_allocated);
    if (!Number.isFinite(n) || n <= 0) return badReq('kg_green_allocated must be > 0', 'INVALID_KG');
  }

  const sb = getSupabase();
  const rows = assignments.map((a) => ({
    production_lot_id,
    demand_order_id: a.demand_order_id,
    kg_green_allocated: Number(a.kg_green_allocated),
  }));

  const { data, error } = await sb
    .from('lot_order_assignments').insert(rows).select();
  if (error) {
    // surface DB-trigger errors with a clearer code
    if (/reference mismatch/i.test(error.message))   return conflict(error.message, 'REFERENCE_MISMATCH');
    if (/process_type mismatch/i.test(error.message))return conflict(error.message, 'PROCESS_MISMATCH');
    if (/exceeds order kg_green_accepted/i.test(error.message))
      return conflict(error.message, 'OVER_ALLOCATED');
    return serverErr('Insert failed', error.message);
  }

  // Promote orders to InProduction
  const orderIds = [...new Set(assignments.map((a) => a.demand_order_id))];
  for (const id of orderIds) {
    const { data: o } = await sb.from('demand_orders').select('id, status').eq('id', id).maybeSingle();
    if (o && (o.status === ORDER_STATUS.Accepted || o.status === ORDER_STATUS.PartiallyAccepted)) {
      await sb.from('demand_orders').update({
        status: ORDER_STATUS.InProduction,
        in_production_at: new Date().toISOString(),
      }).eq('id', id);
    }
  }

  return created({ assignments: data });
});
