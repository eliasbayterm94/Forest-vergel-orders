'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /shipments-list
 * Returns all shipments newest-first with their lots and per-lot
 * order assignments + the demand-order metadata needed to render the
 * printable PDF on the client.
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const sb = getSupabase();

  const { data, error } = await sb
    .from('shipments')
    .select(`
      id, shipment_code, shipment_date, notes, created_by, created_at,
      shipment_lots (
        production_lots (
          id, lot_code, bache_code, process_type, processing_stage,
          kg_cherry_input, kg_despulpado_input,
          kg_dried_output, factor_rendimiento,
          kg_green_expected, kg_green_actual,
          coffee_references ( id, name ),
          production_lot_varieties ( coffee_varieties ( id, name ) ),
          lot_order_assignments (
            id, kg_green_allocated,
            demand_orders (
              id, order_code, status,
              order_type, client_name, regions, contract_code,
              max_delivery_date, physical_aspect, process_type
            )
          )
        )
      )
    `)
    .order('shipment_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) return serverErr('Failed to load shipments', error.message);

  // Flatten the shape (drop the link-table indirection) so the client
  // can iterate naturally: shipment.lots[].assignments[].order.
  const shipments = (data || []).map((s) => {
    const lots = (s.shipment_lots || [])
      .map((sl) => sl.production_lots)
      .filter(Boolean)
      .map((l) => ({
        id: l.id,
        lot_code: l.lot_code,
        bache_code: l.bache_code,
        process_type: l.process_type,
        processing_stage: l.processing_stage,
        kg_cherry_input:    l.kg_cherry_input,
        kg_despulpado_input: l.kg_despulpado_input,
        kg_dried_output:    l.kg_dried_output,
        factor_rendimiento: l.factor_rendimiento,
        kg_green_expected:  l.kg_green_expected,
        kg_green_actual:    l.kg_green_actual,
        reference_name: l.coffee_references && l.coffee_references.name,
        varieties: (l.production_lot_varieties || [])
          .map((j) => j.coffee_varieties).filter(Boolean),
        assignments: (l.lot_order_assignments || []).map((a) => ({
          id: a.id,
          kg_green_allocated: Number(a.kg_green_allocated),
          order: a.demand_orders ? {
            id: a.demand_orders.id,
            order_code: a.demand_orders.order_code,
            status: a.demand_orders.status,
            order_type: a.demand_orders.order_type,
            client_name: a.demand_orders.client_name,
            regions: a.demand_orders.regions,
            contract_code: a.demand_orders.contract_code,
            max_delivery_date: a.demand_orders.max_delivery_date,
            physical_aspect: a.demand_orders.physical_aspect,
            process_type: a.demand_orders.process_type,
          } : null,
        })),
      }));

    const totalKgGreen = lots.reduce((s, l) => s + Number(l.kg_green_actual ?? l.kg_green_expected ?? 0), 0);
    const totalAllocated = lots.reduce((s, l) =>
      s + l.assignments.reduce((ss, a) => ss + Number(a.kg_green_allocated || 0), 0), 0);
    const orderIds = new Set();
    lots.forEach((l) => l.assignments.forEach((a) => a.order && orderIds.add(a.order.id)));

    return {
      id: s.id,
      shipment_code: s.shipment_code,
      shipment_date: s.shipment_date,
      notes: s.notes,
      created_by: s.created_by,
      created_at: s.created_at,
      lots,
      totals: {
        lot_count: lots.length,
        order_count: orderIds.size,
        kg_green: Math.round(totalKgGreen * 100) / 100,
        kg_green_allocated: Math.round(totalAllocated * 100) / 100,
      },
    };
  });

  return ok({ shipments });
});
