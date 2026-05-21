'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { plantSnapshot, CAPACITY } = require('./_lib/weeklyPlan');
const { ok, badReq, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /weekly-plan-get?week=YYYY-MM-DD
 *
 * Devuelve el plan vigente para la semana indicada (lunes ISO) y un
 * snapshot fresco del estado de la planta + cola de pedidos. Si no
 * hay plan persistido para esa semana, devuelve plan_row=null y el
 * caller puede inicializar inputs en cero.
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const week = (event.queryStringParameters || {}).week;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week || '')) {
    return badReq('week must be YYYY-MM-DD', 'INVALID_DATE');
  }

  const sb = getSupabase();

  // Plan persistido (puede no existir todavía).
  const { data: planRow, error: pErr } = await sb
    .from('weekly_plans').select('*').eq('week_start_date', week).maybeSingle();
  if (pErr) return serverErr('Plan lookup failed', pErr.message);

  // Snapshot fresco de planta (baches no Delivered).
  const { data: lots, error: lErr } = await sb
    .from('production_lots')
    .select('id, bache_code, lot_code, status, process_type, kg_input_initial, kg_cherry_input, kg_green_expected, kg_green_actual, drying_locations')
    .neq('status', 'Delivered');
  if (lErr) return serverErr('Lots lookup failed', lErr.message);

  // Cola de pedidos activos con su remaining.
  const { data: orders, error: oErr } = await sb
    .from('demand_orders')
    .select(`
      id, order_code, status, reference_id, process_type,
      kg_green_required, kg_green_accepted, max_delivery_date, client_name,
      coffee_references!left ( name )
    `)
    .in('status', ['Accepted', 'PartiallyAccepted', 'InProduction']);
  if (oErr) return serverErr('Orders lookup failed', oErr.message);

  const { data: assigns } = await sb
    .from('lot_order_assignments').select('demand_order_id, kg_green_allocated');
  const allocByOrder = new Map();
  for (const a of assigns || []) {
    allocByOrder.set(a.demand_order_id,
      (allocByOrder.get(a.demand_order_id) || 0) + Number(a.kg_green_allocated || 0));
  }
  const queueOrders = (orders || []).map((o) => ({
    id: o.id,
    order_code: o.order_code,
    status: o.status,
    process_type: o.process_type,
    reference_name: o.coffee_references && o.coffee_references.name,
    client_name: o.client_name,
    max_delivery_date: o.max_delivery_date,
    kg_green_accepted: Number(o.kg_green_accepted || 0),
    remaining_kg: Math.max(0,
      Number(o.kg_green_accepted || o.kg_green_required || 0) - (allocByOrder.get(o.id) || 0)),
  })).sort((a, b) => (a.max_delivery_date || '').localeCompare(b.max_delivery_date || ''));

  const snapshot = plantSnapshot(lots || []);

  return ok({
    plan_row: planRow || null,
    snapshot,
    capacity: CAPACITY,
    queue_summary: {
      orders_count: queueOrders.length,
      total_remaining_kg: Math.round(queueOrders.reduce((s, o) => s + Number(o.remaining_kg || 0), 0) * 100) / 100,
    },
    queue_orders: queueOrders,
  });
});
