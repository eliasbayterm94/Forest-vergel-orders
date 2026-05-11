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
    if (/reference mismatch/i.test(error.message))    return conflict(error.message, 'REFERENCE_MISMATCH');
    if (/process_type mismatch/i.test(error.message)) return conflict(error.message, 'PROCESS_MISMATCH');

    // Sobrecupo: el trigger devuelve "Total allocated kg (X) exceeds
    // order kg_green_accepted (Y) for order <uuid>". Re-componemos el
    // mensaje en español con order_code y kg disponibles.
    const m = /Total allocated kg \(([\d.]+)\) exceeds order kg_green_accepted \(([\d.]+)\) for order ([a-f0-9-]+)/i
      .exec(error.message);
    if (m) {
      const totalAfter = Number(m[1]);
      const accepted   = Number(m[2]);
      const orderId    = m[3];
      const overflow   = Math.round((totalAfter - accepted) * 100) / 100;
      const { data: o } = await sb
        .from('demand_orders').select('order_code').eq('id', orderId).maybeSingle();
      const code = (o && o.order_code) || orderId.slice(0, 8);
      const already = Math.round((totalAfter - rows.reduce((s, r) => s + Number(r.kg_green_allocated || 0), 0)) * 100) / 100;
      return conflict(
        `Pedido ${code} solo acepta ${accepted} kg verde y ya tiene ${already} asignados de otros lotes. ` +
        `La asignación que intentas excede en ${overflow} kg.`,
        'OVER_ALLOCATED',
        { order_code: code, kg_green_accepted: accepted, kg_already_allocated: already, overflow },
      );
    }
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
