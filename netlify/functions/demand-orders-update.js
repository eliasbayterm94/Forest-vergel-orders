'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { bogotaToday, daysBetween } = require('./_lib/bogotaTime');
const { PROCESS_TYPES, PHYSICAL_ASPECTS, ORDER_STATUS } = require('./_lib/schema');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

const ORDER_TYPES = ['Spot', 'Contract', 'FOB'];
const REGIONS     = ['USA', 'EU', 'UK', 'MENA', 'AU'];

/**
 * POST /demand-orders-update  (forest, admin)
 * Body: { order_id, fields: {...}, override_15_day? }
 *
 * Editable fields (whitelist; all optional):
 *   reference_id, kg_green_required, max_delivery_date, physical_aspect,
 *   process_type, fermentation_hours, comments,
 *   order_type, client_name, regions, contract_code,
 *   variety_ids (array — replaces existing demand_order_varieties)
 *
 * Constraints:
 *   - Order must be in 'Pending' status (lock changes once finca acted on it)
 *   - The 15-day rule still applies if max_delivery_date is being moved to <15d
 *     (returns FIFTEEN_DAY_RULE; pass override_15_day:true to acknowledge)
 */
exports.handler = requireAuth(['forest', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const order_id = body.order_id;
  if (!order_id) return badReq('order_id required', 'ORDER_ID_REQUIRED');
  const fields = body.fields || {};
  const override_15_day = !!body.override_15_day;

  const sb = getSupabase();

  // Load + validate the order is editable.
  const { data: order, error: loadErr } = await sb
    .from('demand_orders').select('id, status, max_delivery_date').eq('id', order_id).maybeSingle();
  if (loadErr) return serverErr('Lookup failed', loadErr.message);
  if (!order) return notFound('Order not found');
  if (order.status !== ORDER_STATUS.Pending) {
    return conflict(
      `Cannot edit order in status "${order.status}" — only Pending orders are editable`,
      'NOT_EDITABLE',
    );
  }

  // Build the update payload from the whitelist.
  const update = {};
  const errors = [];

  if (fields.reference_id !== undefined) update.reference_id = fields.reference_id;

  if (fields.kg_green_required !== undefined) {
    const n = Number(fields.kg_green_required);
    if (!Number.isFinite(n) || n <= 0) errors.push('kg_green_required must be > 0');
    else update.kg_green_required = n;
  }

  let newMaxDate = order.max_delivery_date;
  if (fields.max_delivery_date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.max_delivery_date || '')) {
      errors.push('max_delivery_date must be YYYY-MM-DD');
    } else {
      update.max_delivery_date = fields.max_delivery_date;
      newMaxDate = fields.max_delivery_date;
    }
  }

  if (fields.physical_aspect !== undefined) {
    if (!PHYSICAL_ASPECTS.includes(fields.physical_aspect)) errors.push('physical_aspect invalid');
    else update.physical_aspect = fields.physical_aspect;
  }
  if (fields.process_type !== undefined) {
    if (!PROCESS_TYPES.includes(fields.process_type)) errors.push('process_type invalid');
    else update.process_type = fields.process_type;
  }

  if (fields.fermentation_hours !== undefined) {
    if (fields.fermentation_hours === null || fields.fermentation_hours === '') {
      update.fermentation_hours = null;
    } else {
      const n = Number(fields.fermentation_hours);
      if (!Number.isFinite(n) || n < 0) errors.push('fermentation_hours must be >= 0');
      else update.fermentation_hours = n;
    }
  }

  if (fields.comments !== undefined) update.comments = fields.comments == null ? null : String(fields.comments);

  // Commercial metadata (all optional)
  if (fields.order_type !== undefined) {
    if (fields.order_type && !ORDER_TYPES.includes(fields.order_type)) errors.push('order_type invalid');
    else update.order_type = fields.order_type || null;
  }
  if (fields.client_name !== undefined) {
    update.client_name = fields.client_name ? String(fields.client_name).trim() || null : null;
  }
  if (fields.regions !== undefined) {
    if (fields.regions && !Array.isArray(fields.regions)) errors.push('regions must be an array');
    else if (fields.regions && !fields.regions.every((r) => REGIONS.includes(r))) {
      errors.push('regions must be subset of USA/EU/UK/MENA/AU');
    } else {
      update.regions = fields.regions && fields.regions.length > 0 ? fields.regions : null;
    }
  }
  if (fields.contract_code !== undefined) {
    update.contract_code = fields.contract_code ? String(fields.contract_code).trim() || null : null;
  }

  if (errors.length) return badReq(errors.join('; '), 'VALIDATION_ERROR');
  if (Object.keys(update).length === 0 && fields.variety_ids === undefined) {
    return badReq('No updatable fields provided', 'NO_FIELDS');
  }

  // 15-day rule on max_delivery_date change
  if (update.max_delivery_date !== undefined) {
    const days = daysBetween(bogotaToday(), newMaxDate);
    if (days < 15 && !override_15_day) {
      return conflict(
        'Max delivery date is less than 15 days away — confirmation with finca required.',
        'FIFTEEN_DAY_RULE',
        { days_to_delivery: days, requires_override: true },
      );
    }
    if (override_15_day) update.override_15_day = true;
  }

  // Validate reference exists & active if it's being changed.
  if (update.reference_id) {
    const { data: refRow, error: refErr } = await sb
      .from('coffee_references').select('id, active').eq('id', update.reference_id).maybeSingle();
    if (refErr) return serverErr('Reference lookup failed', refErr.message);
    if (!refRow || !refRow.active) return badReq('Unknown or inactive reference', 'INVALID_REFERENCE');
  }

  // Apply update
  if (Object.keys(update).length > 0) {
    const { error: updErr } = await sb
      .from('demand_orders').update(update).eq('id', order_id);
    if (updErr) return serverErr('Update failed', updErr.message);
  }

  // Replace varieties if provided
  if (Array.isArray(fields.variety_ids)) {
    const { error: delErr } = await sb
      .from('demand_order_varieties').delete().eq('demand_order_id', order_id);
    if (delErr) return serverErr('Failed to clear varieties', delErr.message);
    if (fields.variety_ids.length > 0) {
      const rows = fields.variety_ids.map((variety_id) => ({ demand_order_id: order_id, variety_id }));
      const { error: insErr } = await sb.from('demand_order_varieties').insert(rows);
      if (insErr) return serverErr('Failed to insert varieties', insErr.message);
    }
  }

  // Return the fresh row
  const { data: fresh, error: freshErr } = await sb
    .from('demand_orders').select('*').eq('id', order_id).single();
  if (freshErr) return serverErr('Reload failed', freshErr.message);
  return ok({ order: fresh });
});
