'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { greenToCherry } = require('./_lib/cherryConversion');
const { bogotaToday, daysBetween } = require('./_lib/bogotaTime');
const { PROCESS_TYPES, PHYSICAL_ASPECTS } = require('./_lib/schema');
const { created, badReq, conflict, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

const ORDER_TYPES = ['Spot', 'Contract', 'FOB'];
const REGIONS     = ['USA', 'EU', 'UK', 'MENA', 'AU'];
const MAX_ORDERS_PER_BATCH = 50;

/**
 * POST /demand-orders-create-bulk  (forest, admin)
 * Body: { orders: [...], override_15_day?: boolean }
 *
 * Cada elemento de `orders` tiene el mismo shape que demand-orders-create.
 * Validacion por fila: si cualquiera falla, no se crea ninguno. Si alguna
 * fila viola la regla de 15 dias y override_15_day=false, devuelve
 * FIFTEEN_DAY_RULE con la lista de filas afectadas. La UI confirma y
 * reintenta con override_15_day=true.
 */
exports.handler = requireAuth(['forest', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const orders = Array.isArray(body.orders) ? body.orders : null;
  if (!orders || orders.length === 0) return badReq('orders array required', 'NO_ORDERS');
  if (orders.length > MAX_ORDERS_PER_BATCH) {
    return badReq(`max ${MAX_ORDERS_PER_BATCH} orders per batch`, 'TOO_MANY');
  }
  const override_15_day = !!body.override_15_day;

  // ── Validar cada fila ──
  const today = bogotaToday();
  const rowErrors = [];
  const rowsUnder15 = [];
  const cleaned = [];
  orders.forEach((o, idx) => {
    const errs = [];
    const reference_id = o.reference_id;
    const variety_ids  = Array.isArray(o.variety_ids) ? o.variety_ids : [];
    const kg_green_required = Number(o.kg_green_required);
    const max_delivery_date = o.max_delivery_date;
    const physical_aspect   = o.physical_aspect;
    const process_type      = o.process_type;
    const fermentation_hours = o.fermentation_hours == null ? null : Number(o.fermentation_hours);
    const order_type   = o.order_type   == null ? null : String(o.order_type);
    const regions      = Array.isArray(o.regions) ? o.regions.filter(Boolean) : null;

    if (!reference_id) errs.push('reference_id required');
    if (!Number.isFinite(kg_green_required) || kg_green_required <= 0) errs.push('kg_green_required must be > 0');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(max_delivery_date || '')) errs.push('max_delivery_date must be YYYY-MM-DD');
    if (!PHYSICAL_ASPECTS.includes(physical_aspect)) errs.push('physical_aspect invalid');
    if (!PROCESS_TYPES.includes(process_type)) errs.push('process_type invalid');
    if (fermentation_hours != null && (!Number.isFinite(fermentation_hours) || fermentation_hours < 0))
      errs.push('fermentation_hours must be >= 0');
    if (order_type != null && order_type !== '' && !ORDER_TYPES.includes(order_type)) errs.push('order_type invalid');
    if (regions && !regions.every((r) => REGIONS.includes(r))) errs.push('regions must be subset of USA/EU/UK/MENA/AU');

    if (errs.length) {
      rowErrors.push({ index: idx, errors: errs });
      return;
    }

    const days = daysBetween(today, max_delivery_date);
    if (days < 15 && !override_15_day) rowsUnder15.push({ index: idx, days });

    cleaned.push({
      reference_id,
      variety_ids,
      kg_green_required,
      max_delivery_date,
      physical_aspect,
      process_type,
      fermentation_hours,
      comments: o.comments == null ? null : String(o.comments),
      override_15_day,
      order_type: (order_type === '' ? null : order_type),
      client_name:  o.client_name  == null ? null : String(o.client_name).trim() || null,
      regions:      regions && regions.length > 0 ? regions : null,
      contract_code: o.contract_code == null ? null : String(o.contract_code).trim() || null,
    });
  });

  if (rowErrors.length) {
    return badReq('Validation failed for one or more rows', 'VALIDATION_ERROR', { row_errors: rowErrors });
  }
  if (rowsUnder15.length > 0) {
    return conflict(
      `${rowsUnder15.length} pedido(s) con entrega a menos de 15 días — confirmación requerida.`,
      'FIFTEEN_DAY_RULE',
      { rows_under_15_days: rowsUnder15, requires_override: true },
    );
  }

  const sb = getSupabase();

  // Validar referencias existen + activas (una sola query con IN)
  const refIds = [...new Set(cleaned.map((o) => o.reference_id))];
  const { data: refs, error: refErr } = await sb
    .from('coffee_references').select('id, active').in('id', refIds);
  if (refErr) return serverErr('Reference lookup failed', refErr.message);
  const refMap = new Map((refs || []).map((r) => [r.id, r]));
  const badRefs = [];
  cleaned.forEach((o, idx) => {
    const r = refMap.get(o.reference_id);
    if (!r || !r.active) badRefs.push({ index: idx, reason: 'Unknown or inactive reference' });
  });
  if (badRefs.length) return badReq('Invalid references', 'INVALID_REFERENCE', { row_errors: badRefs });

  // ── Insert atómico (orders + varieties con rollback manual) ──
  const orderRows = cleaned.map((o) => ({
    reference_id: o.reference_id,
    kg_green_required: o.kg_green_required,
    max_delivery_date: o.max_delivery_date,
    physical_aspect:   o.physical_aspect,
    process_type:      o.process_type,
    fermentation_hours: o.fermentation_hours,
    comments:          o.comments,
    override_15_day:   o.override_15_day,
    order_type:        o.order_type,
    client_name:       o.client_name,
    regions:           o.regions,
    contract_code:     o.contract_code,
    created_by:        session.role,
  }));

  const { data: insertedOrders, error: insErr } = await sb
    .from('demand_orders').insert(orderRows).select();
  if (insErr) return serverErr('Failed to create demand orders', insErr.message);

  // Link varieties (todas las relaciones en un solo insert)
  const varietyLinks = [];
  insertedOrders.forEach((row, idx) => {
    const vids = cleaned[idx].variety_ids;
    for (const variety_id of vids) {
      varietyLinks.push({ demand_order_id: row.id, variety_id });
    }
  });
  if (varietyLinks.length > 0) {
    const { error: vErr } = await sb.from('demand_order_varieties').insert(varietyLinks);
    if (vErr) {
      // Rollback: borrar las orders recién creadas para no dejar inconsistencia.
      const ids = insertedOrders.map((r) => r.id);
      await sb.from('demand_orders').delete().in('id', ids);
      return serverErr('Failed to link varieties (rolled back)', vErr.message);
    }
  }

  return created({
    orders: insertedOrders.map((row) => ({
      ...row,
      kg_cherry_required: greenToCherry(Number(row.kg_green_required)),
    })),
  });
});
