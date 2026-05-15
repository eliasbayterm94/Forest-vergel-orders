'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /search?q=foo[&limit=5]
 * Busqueda transversal contra los identificadores visibles del sistema:
 *   - demand_orders.order_code            (ej. FV-2026-0001)
 *   - demand_orders.client_name + contract_code
 *   - production_lots.bache_code / lot_code
 *   - shipments.shipment_code
 *
 * Devuelve hasta `limit` resultados por categoria (default 5). Texto
 * se compara case-insensitive con ILIKE %q%. q debe tener >= 2 chars.
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);

  const q = (event.queryStringParameters && event.queryStringParameters.q || '').trim();
  if (q.length < 2) {
    return ok({ q, orders: [], lots: [], shipments: [] });
  }
  const limit = Math.max(1, Math.min(20, Number(event.queryStringParameters?.limit) || 5));

  const sb = getSupabase();
  const pat = `%${q.replace(/[%_]/g, '\\$&')}%`;

  // Las 3 consultas en paralelo.
  const [ordersR, lotsR, shipsR] = await Promise.all([
    sb.from('demand_orders')
      .select(`
        id, order_code, status, kg_green_required, kg_green_accepted,
        client_name, contract_code, max_delivery_date,
        coffee_references ( name )
      `)
      .or(`order_code.ilike.${pat},client_name.ilike.${pat},contract_code.ilike.${pat}`)
      .order('created_at', { ascending: false })
      .limit(limit),
    sb.from('production_lots')
      .select(`
        id, bache_code, lot_code, status, process_type,
        kg_green_actual, kg_green_expected,
        coffee_references!left ( name )
      `)
      .or(`bache_code.ilike.${pat},lot_code.ilike.${pat}`)
      .order('start_date', { ascending: false })
      .limit(limit),
    sb.from('shipments')
      .select('id, shipment_code, shipment_date, notes')
      .ilike('shipment_code', pat)
      .order('shipment_date', { ascending: false })
      .limit(limit),
  ]);

  if (ordersR.error) return serverErr('Order search failed', ordersR.error.message);
  if (lotsR.error)   return serverErr('Lot search failed',   lotsR.error.message);
  if (shipsR.error)  return serverErr('Shipment search failed', shipsR.error.message);

  const orders = (ordersR.data || []).map((o) => ({
    id: o.id,
    code: o.order_code,
    status: o.status,
    reference_name: o.coffee_references?.name || null,
    client_name: o.client_name,
    contract_code: o.contract_code,
    kg_green_required: o.kg_green_required,
    kg_green_accepted: o.kg_green_accepted,
    max_delivery_date: o.max_delivery_date,
  }));
  const lots = (lotsR.data || []).map((l) => ({
    id: l.id,
    code: l.bache_code || l.lot_code,
    lot_code: l.lot_code,
    status: l.status,
    process_type: l.process_type,
    reference_name: l.coffee_references?.name || null,
    kg_green: l.kg_green_actual ?? l.kg_green_expected,
  }));
  const shipments = (shipsR.data || []).map((s) => ({
    id: s.id,
    code: s.shipment_code,
    shipment_date: s.shipment_date,
  }));

  return ok({ q, orders, lots, shipments });
});
