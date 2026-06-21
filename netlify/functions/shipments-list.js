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
      destino_kind, destino_other,
      driver_cedula, driver_placas, driver_name,
      shipment_lots (
        id, lot_partial_id, kg_dried_shipped,
        codigo_trilladora, codigo_mezcla, num_sacos, partials_merged,
        lot_partials ( id, parcial_letter, kg_dried, factor_rendimiento, kg_green_yield ),
        production_lots (
          id, lot_code, bache_code, blend_code, is_blend,
          process_type, processing_stage,
          kg_cherry_input, kg_despulpado_input,
          kg_dried_output, factor_rendimiento,
          kg_green_expected, kg_green_actual,
          coffee_references!left ( id, name ),
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

  // Flatten + group: a shipment can contain whole lots OR specific
  // partials of a lot. We collapse rows by lot_id so the UI sees one
  // entry per lot with `partials_in_shipment` listing which letters
  // are part of THIS despacho.
  const shipments = (data || []).map((s) => {
    const groups = new Map();   // lot_id → { lot, partials_in_shipment[], whole }
    for (const sl of s.shipment_lots || []) {
      const l = sl.production_lots;
      if (!l) continue;
      let g = groups.get(l.id);
      if (!g) {
        g = {
          id: l.id,
          lot_code: l.lot_code,
          bache_code: l.bache_code,
          blend_code: l.blend_code,
          is_blend: !!l.is_blend,
          process_type: l.process_type,
          processing_stage: l.processing_stage,
          kg_cherry_input:    l.kg_cherry_input,
          kg_despulpado_input: l.kg_despulpado_input,
          kg_dried_output:    l.kg_dried_output,
          factor_rendimiento: l.factor_rendimiento,
          kg_green_expected:  l.kg_green_expected,
          kg_green_actual:    l.kg_green_actual,
          // Por-bache: tomamos los valores del primer shipment_lots de
          // este bache. Si hay varios partials separados con valores
          // distintos, el operador puede verlos por shipment_lot abajo.
          codigo_trilladora: sl.codigo_trilladora,
          codigo_mezcla:     sl.codigo_mezcla,
          num_sacos:         sl.num_sacos,
          partials_merged:   sl.partials_merged !== false,
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
          partials_in_shipment: [],
          whole_lot_in_shipment: false,
          // kg seco realmente despachado en este shipment (suma de
          // shipment_lots.kg_dried_shipped para las filas whole/partial-by-kg
          // de este bache). Puede ser menor que kg_dried_output si fue
          // despacho parcial. Queda en null si todo va por partials.
          kg_dried_shipped: null,
        };
        groups.set(l.id, g);
      }
      if (sl.lot_partial_id && sl.lot_partials) {
        g.partials_in_shipment.push({
          id: sl.lot_partials.id,
          parcial_letter: sl.lot_partials.parcial_letter,
          kg_dried: Number(sl.lot_partials.kg_dried),
          factor_rendimiento: Number(sl.lot_partials.factor_rendimiento),
          kg_green_yield: Number(sl.lot_partials.kg_green_yield),
          // Si los parciales del bache se mostraron separados, cada uno
          // puede traer sus propios códigos.
          codigo_trilladora: sl.codigo_trilladora,
          codigo_mezcla:     sl.codigo_mezcla,
          num_sacos:         sl.num_sacos,
        });
      } else {
        g.whole_lot_in_shipment = true;
        if (sl.kg_dried_shipped != null) {
          g.kg_dried_shipped = (g.kg_dried_shipped || 0) + Number(sl.kg_dried_shipped);
        }
      }
    }

    const lots = [...groups.values()].map((g) => {
      g.partials_in_shipment.sort((a, b) => a.parcial_letter.localeCompare(b.parcial_letter));
      // kg_green effectively shipped for this lot in this despacho.
      // Para whole/partial-by-kg prorratea: si despachó 200 de 350,
      // el verde shipping = totalGreen * (200/350).
      if (g.whole_lot_in_shipment) {
        const driedTotal = Number(g.kg_dried_output || 0);
        const driedShipped = g.kg_dried_shipped != null ? Number(g.kg_dried_shipped) : driedTotal;
        const greenTotal = Number(g.kg_green_actual ?? g.kg_green_expected ?? 0);
        g.kg_green_in_shipment = driedTotal > 0
          ? greenTotal * (driedShipped / driedTotal)
          : greenTotal;
      } else {
        g.kg_green_in_shipment = g.partials_in_shipment.reduce((s, p) => s + Number(p.kg_green_yield || 0), 0);
      }
      return g;
    });

    const totalKgGreen = lots.reduce((s, l) => s + Number(l.kg_green_in_shipment || 0), 0);
    const totalAllocated = lots.reduce((s, l) =>
      s + l.assignments.reduce((ss, a) => ss + Number(a.kg_green_allocated || 0), 0), 0);
    // Kg seco efectivo en el despacho:
    //   whole/partial-by-kg → kg_dried_shipped (lo realmente sacado)
    //                          o kg_dried_output como fallback
    //   por parciales       → suma de kg_dried de cada parcial
    const totalKgDried = lots.reduce((sum, l) => {
      const dried = Number(l.kg_dried_output || 0);
      const greenAc = Number(l.kg_green_actual || l.kg_green_expected || 0);
      if (l.whole_lot_in_shipment) {
        return sum + (l.kg_dried_shipped != null ? Number(l.kg_dried_shipped) : dried);
      }
      // Parciales: kg_dried directo de cada partial.
      const partialDried = (l.partials_in_shipment || []).reduce((s, p) => {
        if (p.kg_dried) return s + Number(p.kg_dried);
        // Fallback: prorratear por kg_green.
        return s + (greenAc > 0 ? dried * (Number(p.kg_green_yield || 0) / greenAc) : 0);
      }, 0);
      return sum + partialDried;
    }, 0);
    const totalSacos = lots.reduce((s, l) => {
      if (l.partials_merged !== false) return s + (Number(l.num_sacos) || 0);
      // Si separados, sumar de partials.
      return s + (l.partials_in_shipment || []).reduce((ss, p) => ss + (Number(p.num_sacos) || 0), 0);
    }, 0);
    const orderIds = new Set();
    lots.forEach((l) => l.assignments.forEach((a) => a.order && orderIds.add(a.order.id)));

    return {
      id: s.id,
      shipment_code: s.shipment_code,
      shipment_date: s.shipment_date,
      notes: s.notes,
      created_by: s.created_by,
      created_at: s.created_at,
      destino_kind: s.destino_kind,
      destino_other: s.destino_other,
      driver_cedula: s.driver_cedula,
      driver_placas: s.driver_placas,
      driver_name:   s.driver_name,
      lots,
      totals: {
        lot_count: lots.length,
        order_count: orderIds.size,
        kg_green: Math.round(totalKgGreen * 100) / 100,
        kg_green_allocated: Math.round(totalAllocated * 100) / 100,
        kg_dried: Math.round(totalKgDried * 100) / 100,
        num_sacos: totalSacos,
      },
    };
  });

  return ok({ shipments });
});
