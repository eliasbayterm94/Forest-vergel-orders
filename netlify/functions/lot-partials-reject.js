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
    .select('id, parcial_letter, rejected_at, production_lots!inner(id, status)')
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

  // Calcular si el lote queda over-allocated despues del cambio.
  // Capacidad efectiva = sum(kg_green_yield de partials NO rechazados).
  // Si no hay parciales (lote legacy) usamos kg_green_actual / expected.
  const lotId = row.production_lots.id;
  const overAllocation = await computeOverAllocation(sb, lotId);

  return ok({ partial: upd, over_allocation: overAllocation });
});

async function computeOverAllocation(sb, lotId) {
  const { data: lot } = await sb
    .from('production_lots')
    .select(`
      id, bache_code, lot_code,
      kg_green_actual, kg_green_expected,
      lot_partials ( id, kg_green_yield, rejected_at ),
      lot_order_assignments ( id, demand_order_id, kg_green_allocated,
        demand_orders ( order_code, client_name ) )
    `)
    .eq('id', lotId).maybeSingle();
  if (!lot) return null;

  const partials = lot.lot_partials || [];
  let capacity;
  if (partials.length === 0) {
    capacity = Number(lot.kg_green_actual ?? lot.kg_green_expected ?? 0);
  } else {
    capacity = partials
      .filter((p) => !p.rejected_at)
      .reduce((s, p) => s + Number(p.kg_green_yield || 0), 0);
  }

  const assigns = (lot.lot_order_assignments || []).map((a) => ({
    id: a.id,
    demand_order_id: a.demand_order_id,
    order_code: a.demand_orders?.order_code,
    client_name: a.demand_orders?.client_name,
    kg_green_allocated: Number(a.kg_green_allocated || 0),
  }));
  const totalAllocated = assigns.reduce((s, a) => s + a.kg_green_allocated, 0);
  const overflow = totalAllocated - capacity;
  if (overflow <= 0.01) return null;

  return {
    lot_id: lot.id,
    bache_code: lot.bache_code || lot.lot_code,
    capacity,
    total_allocated: totalAllocated,
    overflow,
    assignments: assigns,
  };
}
