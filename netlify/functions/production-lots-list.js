'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /production-lots-list
 *   ?status=InFermentation,Drying,...   (csv, optional)
 *   ?reference_id=...                   (optional)
 *   ?process_type=Natural               (optional)
 *   ?active_only=true                   (status NOT IN Delivered)
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const sb = getSupabase();
  const q = event.queryStringParameters || {};

  let query = sb.from('production_lots').select(`
    id, lot_code, reference_id, process_type,
    kg_cherry_input, kg_green_expected, kg_green_actual,
    status, fermentation_hours,
    start_date, drying_start_date, ready_date, delivered_date,
    notes, created_by, created_at, updated_at,
    coffee_references ( id, name ),
    production_lot_varieties ( coffee_varieties ( id, name ) ),
    lot_order_assignments (
      id, demand_order_id, kg_green_allocated,
      demand_orders ( id, order_code, status, max_delivery_date )
    )
  `);

  if (q.status)        query = query.in('status', q.status.split(',').map((s) => s.trim()).filter(Boolean));
  if (q.reference_id)  query = query.eq('reference_id', q.reference_id);
  if (q.process_type)  query = query.eq('process_type', q.process_type);
  if (q.active_only === 'true') query = query.neq('status', 'Delivered');

  query = query.order('start_date', { ascending: false });

  const { data, error } = await query;
  if (error) return serverErr('Failed to load production lots', error.message);

  const lots = (data || []).map((l) => ({
    ...l,
    reference_name: l.coffee_references && l.coffee_references.name,
    varieties: (l.production_lot_varieties || []).map((j) => j.coffee_varieties).filter(Boolean),
    assignments: (l.lot_order_assignments || []).map((a) => ({
      id: a.id,
      demand_order_id: a.demand_order_id,
      kg_green_allocated: Number(a.kg_green_allocated),
      order: a.demand_orders,
    })),
    coffee_references: undefined,
    production_lot_varieties: undefined,
    lot_order_assignments: undefined,
  }));

  return ok({ lots });
});
