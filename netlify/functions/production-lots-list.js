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
    id, lot_code, bache_code, blend_code, is_blend,
    parent_lot_id, sub_bache_number,
    reference_id, process_type, processing_stage,
    kg_cherry_input, kg_despulpado_input,
    kg_green_expected, kg_green_actual,
    kg_dried_output, factor_rendimiento,
    status, fermentation_hours,
    start_date, drying_start_date, ready_date, delivered_date,
    drying_locations,
    resting_start_date, resting_humidity,
    kg_input_initial, conversion_factor,
    final_humidity, fermentation_tanks,
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
    ),
    lot_blend_components!source_lot_id ( kg_dried_used ),
    lot_purchases ( id, client_name, kg_green_allocated, notes, created_at )
  `);

  if (q.id)            query = query.eq('id', q.id);
  if (q.status)        query = query.in('status', q.status.split(',').map((s) => s.trim()).filter(Boolean));
  if (q.reference_id)  query = query.eq('reference_id', q.reference_id);
  if (q.process_type)  query = query.eq('process_type', q.process_type);
  if (q.active_only === 'true') query = query.neq('status', 'Delivered');

  query = query.order('start_date', { ascending: false });

  const { data, error } = await query;
  if (error) return serverErr('Failed to load production lots', error.message);

  // Para los lotes que son mezcla (is_blend=true), traemos sus
  // componentes (los baches padre que se combinaron) en una segunda
  // query. Evita un self-join complejo en PostgREST.
  const blendLotIds = (data || []).filter((l) => l.is_blend).map((l) => l.id);
  const componentsByBlend = new Map();
  if (blendLotIds.length > 0) {
    const { data: comps, error: compErr } = await sb
      .from('lot_blend_components')
      .select('blend_lot_id, kg_dried_used, source:production_lots!source_lot_id(id, bache_code, blend_code, lot_code, process_type)')
      .in('blend_lot_id', blendLotIds);
    if (!compErr) {
      for (const c of comps || []) {
        const arr = componentsByBlend.get(c.blend_lot_id) || [];
        const s = c.source || {};
        arr.push({
          source_lot_id: s.id || null,
          bache_code:    s.bache_code || null,
          blend_code:    s.blend_code || null,
          lot_code:      s.lot_code   || null,
          process_type:  s.process_type || null,
          kg_dried_used: Number(c.kg_dried_used || 0),
        });
        componentsByBlend.set(c.blend_lot_id, arr);
      }
    }
  }

  const lots = (data || []).map((l) => {
    // kg seco consumido por mezclas en las que este bache participó
    // como padre. (Para el blend resultante is_blend=true y no entra
    // aquí — solo cuentan los aportes a OTROS blends.)
    const kgDriedUsedInBlends = (l.lot_blend_components || [])
      .reduce((s, r) => s + Number(r.kg_dried_used || 0), 0);
    // kg seco ya despachado vía parciales con shipment_id.
    const kgDriedShippedInPartials = (l.lot_partials || [])
      .filter((p) => p.shipment_lots && p.shipment_lots.length > 0)
      .reduce((s, p) => s + Number(p.kg_dried || 0), 0);
    const kgDriedAvailable = Math.max(0,
      Number(l.kg_dried_output || 0) - kgDriedUsedInBlends - kgDriedShippedInPartials);

    // ── Verde: total, comprometido (pedidos + compras) y disponible
    // neto real (descontando además lo que ya salió físicamente:
    // mezclas + parciales despachados, convertido a verde por ratio).
    const totalGreen = Number(l.kg_green_actual ?? l.kg_green_expected ?? 0);
    const totalDried = Number(l.kg_dried_output ?? 0);
    const greenPerDried = totalDried > 0 ? totalGreen / totalDried : 0;
    const greenGone = (kgDriedUsedInBlends + kgDriedShippedInPartials) * greenPerDried;
    const assignedOrdersGreen = (l.lot_order_assignments || [])
      .reduce((s, a) => s + Number(a.kg_green_allocated || 0), 0);
    const assignedPurchasesGreen = (l.lot_purchases || [])
      .reduce((s, p) => s + Number(p.kg_green_allocated || 0), 0);
    const greenAssigned = assignedOrdersGreen + assignedPurchasesGreen;
    const greenAvailable = Math.max(0, totalGreen - greenGone - greenAssigned);

    return {
    ...l,
    reference_name: l.coffee_references && l.coffee_references.name,
    infusion_name:  l.infusions && l.infusions.name,
    varieties: (l.production_lot_varieties || []).map((j) => j.coffee_varieties).filter(Boolean),
    kg_dried_used_in_blends: Math.round(kgDriedUsedInBlends * 100) / 100,
    kg_dried_available: Math.round(kgDriedAvailable * 100) / 100,
    blend_components: l.is_blend ? (componentsByBlend.get(l.id) || []) : [],
    kg_green_assigned_orders:    Math.round(assignedOrdersGreen * 100) / 100,
    kg_green_assigned_purchases: Math.round(assignedPurchasesGreen * 100) / 100,
    kg_green_assigned:           Math.round(greenAssigned * 100) / 100,
    kg_green_available:          Math.round(greenAvailable * 100) / 100,
    purchases: (l.lot_purchases || []).map((p) => ({
      id: p.id,
      client_name: p.client_name,
      kg_green_allocated: Number(p.kg_green_allocated),
      notes: p.notes,
      created_at: p.created_at,
    })),
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
    lot_blend_components: undefined,
    lot_purchases: undefined,
    };
  });

  return ok({ lots });
});
