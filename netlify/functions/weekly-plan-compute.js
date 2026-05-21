'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { computePlan } = require('./_lib/weeklyPlan');
const { ok, badReq, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /weekly-plan-compute  (finca, admin)
 * Body:
 *   week_start_date: 'YYYY-MM-DD' (lunes ISO)
 *   day_inputs: { 'YYYY-MM-DD': { cereza, despulpado, seco } }  // los 7 días
 *
 * Calcula el plan, lo guarda (upsert por week_start_date) y devuelve
 * { plan_row, computed: { plan, alerts, feasibility_pct, snapshot, totals } }.
 */
exports.handler = requireAuth(['finca', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const weekStartDate = body.week_start_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStartDate || '')) {
    return badReq('week_start_date must be YYYY-MM-DD', 'INVALID_DATE');
  }
  const dayInputs = body.day_inputs && typeof body.day_inputs === 'object' ? body.day_inputs : {};

  const sb = getSupabase();

  // ── Cargar contexto: pedidos activos + baches en curso ──
  // Pedidos: Accepted/PartiallyAccepted/InProduction. Para remaining_kg
  // necesitamos sus asignaciones existentes.
  const { data: orders, error: oErr } = await sb
    .from('demand_orders')
    .select(`
      id, order_code, status, reference_id, process_type,
      kg_green_required, kg_green_accepted, max_delivery_date, client_name,
      coffee_references!left ( name )
    `)
    .in('status', ['Accepted', 'PartiallyAccepted', 'InProduction']);
  if (oErr) return serverErr('Orders lookup failed', oErr.message);

  // Asignaciones por pedido (kg ya cubiertos) — sumamos sin filtrar por
  // status del lote, para que el plan no re-asigne kg ya cubiertos por
  // un lote Delivered.
  const { data: assigns } = await sb
    .from('lot_order_assignments').select('demand_order_id, kg_green_allocated');
  const allocByOrder = new Map();
  for (const a of assigns || []) {
    allocByOrder.set(a.demand_order_id,
      (allocByOrder.get(a.demand_order_id) || 0) + Number(a.kg_green_allocated || 0));
  }
  const ordersWithRemaining = (orders || []).map((o) => ({
    ...o,
    reference_name: o.coffee_references && o.coffee_references.name,
    remaining_kg: Math.max(0,
      Number(o.kg_green_accepted || o.kg_green_required || 0) - (allocByOrder.get(o.id) || 0)),
  }));

  // Baches en curso (no Delivered) para snapshot de planta
  const { data: lots, error: lErr } = await sb
    .from('production_lots')
    .select('id, status, process_type, kg_green_expected, kg_green_actual, drying_locations')
    .neq('status', 'Delivered');
  if (lErr) return serverErr('Lots lookup failed', lErr.message);

  // ── Calcular plan ──
  let computed;
  try {
    computed = computePlan({
      weekStartDate, dayInputs,
      orders: ordersWithRemaining,
      lots: lots || [],
    });
  } catch (e) {
    return serverErr('Plan computation failed', e.message);
  }

  // ── Upsert weekly_plans ──
  // Persistimos plan + flow (Gantt/heatmap) en plan_json para que la
  // vista pueda renderizarlos al recargar sin recalcular.
  const row = {
    week_start_date: weekStartDate,
    day_inputs: dayInputs,
    plan_json: { days: computed.plan, flow: computed.flow, coverage: computed.coverage, totals: computed.totals },
    alerts_json: computed.alerts,
    feasibility_pct: computed.feasibility_pct,
    generated_at: new Date().toISOString(),
    generated_by: session.role,
  };
  const { data: saved, error: saveErr } = await sb
    .from('weekly_plans').upsert(row, { onConflict: 'week_start_date' }).select().single();
  if (saveErr) return serverErr('Save failed', saveErr.message);

  return ok({
    plan_row: saved,
    computed,
  });
});
