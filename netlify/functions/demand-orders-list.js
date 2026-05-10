'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase, getDryingDaysByProcess, getProcessingDaysByProcess } = require('./_lib/supabase');
const { greenToCherry } = require('./_lib/cherryConversion');
const { latestDryingStartDate, urgencyOf } = require('./_lib/leadTime');
const { bogotaToday, daysBetween } = require('./_lib/bogotaTime');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /demand-orders-list
 *   ?status=Pending,Accepted,...  (csv, optional)
 *   ?reference_id=...             (optional)
 *   ?process_type=Natural         (optional)
 *
 * Returns enriched orders with derived fields (kg_cherry,
 * latest_drying_start_date, urgency, delivery_urgency).
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const sb = getSupabase();
  const q = event.queryStringParameters || {};

  let query = sb.from('demand_orders').select(`
    id, order_code, reference_id, kg_green_required, kg_green_accepted,
    max_delivery_date, physical_aspect, process_type, fermentation_hours,
    comments, status, override_15_day, rejection_reason,
    order_type, client_name, regions, contract_code,
    external_po_status, external_po_supplier, external_po_code,
    external_po_date, external_po_notes,
    created_by, created_at, updated_at,
    accepted_at, rejected_at, in_production_at, completed_at, cancelled_at,
    coffee_references ( id, name ),
    demand_order_varieties ( coffee_varieties ( id, name ) )
  `);

  if (q.status)        query = query.in('status', q.status.split(',').map((s) => s.trim()).filter(Boolean));
  if (q.reference_id)  query = query.eq('reference_id', q.reference_id);
  if (q.process_type)  query = query.eq('process_type', q.process_type);

  query = query.order('max_delivery_date', { ascending: true });

  const { data, error } = await query;
  if (error) return serverErr('Failed to load demand orders', error.message);

  let dryingDays, processingDays;
  try {
    dryingDays = await getDryingDaysByProcess();
    processingDays = await getProcessingDaysByProcess();
  } catch (e) { return serverErr('Failed to load lead times', e.message); }

  const today = bogotaToday();
  const orders = (data || []).map((o) => {
    const latest = latestDryingStartDate(o.max_delivery_date, o.process_type, dryingDays, processingDays);
    const deliveryDelta = daysBetween(today, o.max_delivery_date);
    const deliveryUrgency = deliveryDelta < 0 ? 'past' : (deliveryDelta <= 7 ? 'red' : (deliveryDelta <= 14 ? 'yellow' : 'normal'));
    return {
      ...o,
      reference_name: o.coffee_references && o.coffee_references.name,
      varieties: (o.demand_order_varieties || []).map((j) => j.coffee_varieties).filter(Boolean),
      kg_cherry_required: greenToCherry(Number(o.kg_green_required || 0)),
      kg_cherry_accepted: o.kg_green_accepted == null ? null : greenToCherry(Number(o.kg_green_accepted)),
      kg_green_external_needed: ['PartiallyAccepted', 'Rejected'].includes(o.status)
        ? Number(o.kg_green_required) - Number(o.kg_green_accepted || 0)
        : 0,
      latest_drying_start_date: latest,
      drying_urgency: urgencyOf(latest, today),
      delivery_urgency: deliveryUrgency,
      coffee_references: undefined,
      demand_order_varieties: undefined,
    };
  });

  return ok({ orders, today });
});
