'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { LOT_STATUS, ORDER_STATUS } = require('./_lib/schema');
const { maybeCompleteOrder } = require('./_lib/orderCompletion');
const { ok, created, badReq, serverErr, conflict, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /lot-assignments-create  (finca, admin)
 * Body:
 *   production_lot_id   uuid
 *   assignments         [{ demand_order_id, kg_green_allocated }]
 *
 * Producción puede asignar CUALQUIER bache a CUALQUIER pedido activo.
 * El único control DB es el de inventario por lote (trg_loa_lot_capacity)
 * que impide asignar más kg verde de los que el bache produjo.
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
    // Inventario por lote: el trigger trg_loa_lot_capacity sigue activo.
    if (/exceed lot capacity/i.test(error.message)) {
      return conflict(error.message, 'LOT_OVER_ALLOCATED');
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

  // Asignación retroactiva: si el lote ya está despachado, los pedidos
  // recién asignados pueden quedar inmediatamente cubiertos al 100%.
  // Ejecutamos el chequeo de completion (mismo helper que update-status).
  const completions = [];
  const { data: lotRow } = await sb
    .from('production_lots').select('status').eq('id', production_lot_id).maybeSingle();
  if (lotRow && lotRow.status === LOT_STATUS.Delivered) {
    for (const id of orderIds) {
      const result = await maybeCompleteOrder(sb, id);
      if (result) completions.push(result);
    }
  }

  return created({ assignments: data, completions });
});
