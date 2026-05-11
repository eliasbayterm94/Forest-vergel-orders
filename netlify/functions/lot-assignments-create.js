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
    // Sobrecupo de pedido: el trigger antiguo (migration 0019 lo
    // relaja) podia disparar este mensaje. Si esa migracion no esta
    // aplicada todavia, reformulamos el error en español; con 0019
    // aplicada esta rama nunca se ejecuta.
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
      return conflict(
        `Pedido ${code} ya tiene asignaciones por ${totalAfter} kg verde; ` +
        `excede el aceptado (${accepted}) en ${overflow} kg. ` +
        `Si esto es un excedente esperado aplica la migración 0019.`,
        'OVER_ALLOCATED',
      );
    }
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
