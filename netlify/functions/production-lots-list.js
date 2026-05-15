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
    id, lot_code, bache_code, reference_id, process_type, processing_stage,
    kg_cherry_input, kg_despulpado_input,
    kg_green_expected, kg_green_actual,
    kg_dried_output, factor_rendimiento,
    status, fermentation_hours,
    start_date, drying_start_date, ready_date, delivered_date,
    drying_locations,
    resting_start_date, resting_humidity,
    kg_input_initial, conversion_factor,
    notes, created_by, created_at, updated_at,
    infusion_id, infusion_pct,
    lot_resting_cycles (
      id, cycle_number, start_date, start_humidity,
      end_date, end_humidity, end_reason
    ),
    coffee_references!left ( id, name ),
    infusions ( id, name ),
    production_lot_varieties ( coffee_varieties ( id, name ) ),
    lot_partials (
      id, parcial_letter, kg_dried, factor_rendimiento, kg_green_yield,
      completed_at, notes, created_at,
      rejected_at, rejection_reason,
      shipment_lots!lot_partial_id (
        shipment_id, shipments ( shipment_code, shipment_date )
      )
    ),
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
    infusion_name:  l.infusions && l.infusions.name,
    varieties: (l.production_lot_varieties || []).map((j) => j.coffee_varieties).filter(Boolean),
    partials: (l.lot_partials || [])
      .map((p) => {
        const link = (p.shipment_lots || [])[0];
        return {
          id: p.id,
          parcial_letter: p.parcial_letter,
          kg_dried: Number(p.kg_dried),
          factor_rendimiento: Number(p.factor_rendimiento),
          kg_green_yield: Number(p.kg_green_yield),
          completed_at: p.completed_at,
          notes: p.notes,
          created_at: p.created_at,
          rejected_at: p.rejected_at,
          rejection_reason: p.rejection_reason,
          shipment_id:    link ? link.shipment_id : null,
          shipment_code:  link && link.shipments ? link.shipments.shipment_code : null,
          shipment_date:  link && link.shipments ? link.shipments.shipment_date : null,
        };
      })
      .sort((a, b) => a.parcial_letter.localeCompare(b.parcial_letter)),
    assignments: (l.lot_order_assignments || []).map((a) => ({
      id: a.id,
      demand_order_id: a.demand_order_id,
      kg_green_allocated: Number(a.kg_green_allocated),
      order: a.demand_orders,
    })),
    resting_cycles: (l.lot_resting_cycles || [])
      .map((c) => ({
        id: c.id,
        cycle_number: c.cycle_number,
        start_date: c.start_date,
        start_humidity: c.start_humidity != null ? Number(c.start_humidity) : null,
        end_date: c.end_date,
        end_humidity: c.end_humidity != null ? Number(c.end_humidity) : null,
        end_reason: c.end_reason,
      }))
      .sort((a, b) => a.cycle_number - b.cycle_number),
    resting_cycles_count: (l.lot_resting_cycles || []).length,
    coffee_references: undefined,
    infusions: undefined,
    production_lot_varieties: undefined,
    lot_partials: undefined,
    lot_order_assignments: undefined,
    lot_resting_cycles: undefined,
  }));

  return ok({ lots });
});
