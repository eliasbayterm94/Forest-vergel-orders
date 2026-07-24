'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');
const {
  sumBlendedKg, sumShippedFromPartials, sumAllocatedGreen,
  driedLedger, greenLedger, round2,
} = require('./_lib/lotInventory');

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
    final_humidity, fermentation_tanks, fermentation_types,
    fermentation_start_at, drying_start_at,
    notes, created_by, created_at, updated_at,
    infusion_id, infusion_pct,
    lot_resting_cycles (
      id, cycle_number, start_date, start_humidity,
      end_date, end_humidity, end_reason, drying_locations_after
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

  // Despachos directos al bache (whole-lot o partial-by-kg, donde
  // lot_partial_id IS NULL). El embedding lot_partials.shipment_lots
  // SOLO captura los despachos hechos vía partials (P1, P2…) y por
  // eso necesitamos esta segunda consulta para que kg_dried_available
  // descuente también los partial-by-kg.
  const lotIdsAll = (data || []).map((l) => l.id);
  const wholeShipKgByLot = new Map();
  const wholeShipDetailsByLot = new Map();   // lot_id → [{ shipment_id, shipment_code, shipment_date, kg }]
  if (lotIdsAll.length > 0) {
    const { data: wholeShips, error: wsErr } = await sb
      .from('shipment_lots')
      .select('production_lot_id, kg_dried_shipped, kg_dried_merma, split_label, shipment_id, shipments(shipment_code, shipment_date)')
      .in('production_lot_id', lotIdsAll)
      .is('lot_partial_id', null);
    if (!wsErr) {
      for (const r of wholeShips || []) {
        // La merma (despacho total con peso real de báscula) cuenta
        // como kg salidos de bodega — sin esto quedaría saldo fantasma.
        wholeShipKgByLot.set(r.production_lot_id,
          (wholeShipKgByLot.get(r.production_lot_id) || 0)
          + Number(r.kg_dried_shipped || 0) + Number(r.kg_dried_merma || 0));
        const arr = wholeShipDetailsByLot.get(r.production_lot_id) || [];
        arr.push({
          shipment_id: r.shipment_id,
          shipment_code: r.shipments && r.shipments.shipment_code,
          shipment_date: r.shipments && r.shipments.shipment_date,
          kg_dried: Number(r.kg_dried_shipped || 0),
          kg_dried_merma: r.kg_dried_merma == null ? null : Number(r.kg_dried_merma),
          split_label: r.split_label || null,
          via: 'whole',
        });
        wholeShipDetailsByLot.set(r.production_lot_id, arr);
      }
    }
  }

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
    // Inventario del bache — la matemática vive en _lib/lotInventory
    // (fuente única, compartida con lotAvailability y shipments-create).
    //   · blended: kg seco consumido por mezclas donde este bache es
    //     fuente (para el blend resultante is_blend=true y no entra
    //     aquí — solo cuentan los aportes a OTROS blends)
    //   · shippedPartials: despachos vía parciales (embed
    //     lot_partials[].shipment_lots)
    //   · shippedWhole: despachos whole/partial-by-kg (segunda query,
    //     filas con lot_partial_id IS NULL). Sin esto, un despacho
    //     parcial de 200 kg de un bache de 350 dejaba el available en
    //     350 (debería ser 150).
    const dl = driedLedger({
      kgDriedOutput: l.kg_dried_output,
      blendedKg: sumBlendedKg(l.lot_blend_components),
      shippedPartialsKg: sumShippedFromPartials(l.lot_partials),
      shippedWholeKg: wholeShipKgByLot.get(l.id) || 0,
    });
    const gl = greenLedger({
      kgGreenActual: l.kg_green_actual,
      kgGreenExpected: l.kg_green_expected,
      kgDriedOutput: l.kg_dried_output,
      driedOutKg: dl.out,
      assignedOrdersKg: sumAllocatedGreen(l.lot_order_assignments),
      assignedPurchasesKg: sumAllocatedGreen(l.lot_purchases),
    });

    return {
    ...l,
    reference_name: l.coffee_references && l.coffee_references.name,
    infusion_name:  l.infusions && l.infusions.name,
    varieties: (l.production_lot_varieties || []).map((j) => j.coffee_varieties).filter(Boolean),
    kg_dried_used_in_blends: round2(dl.blended),
    kg_dried_shipped:        round2(dl.shipped),
    kg_dried_available:      round2(dl.available),
    // Detalle de despachos: cada elemento referencia un shipment con
    // el kg seco que aportó este bache. Soporta tanto despachos por
    // partials (P1, P2…) como whole/partial-by-kg. Para pintar pills
    // clickeables en Punto Final.
    shipments: (() => {
      const out = [];
      const wholeArr = wholeShipDetailsByLot.get(l.id) || [];
      out.push(...wholeArr);
      for (const p of l.lot_partials || []) {
        for (const sl of p.shipment_lots || []) {
          const s = sl.shipments || {};
          out.push({
            shipment_id: sl.shipment_id,
            shipment_code: s.shipment_code,
            shipment_date: s.shipment_date,
            kg_dried: Number(p.kg_dried || 0),
            via: 'partial',
            parcial_letter: p.parcial_letter,
          });
        }
      }
      // Más recientes primero
      out.sort((a, b) => (b.shipment_date || '').localeCompare(a.shipment_date || ''));
      return out;
    })(),
    blend_components: l.is_blend ? (componentsByBlend.get(l.id) || []) : [],
    kg_green_assigned_orders:    round2(gl.assignedOrders),
    kg_green_assigned_purchases: round2(gl.assignedPurchases),
    kg_green_assigned:           round2(gl.assigned),
    kg_green_available:          round2(gl.available),
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
        drying_locations_after: Array.isArray(c.drying_locations_after) ? c.drying_locations_after : [],
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
