'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /production-lots-update  (finca, admin)
 * Body: { lot_id, fields }
 * Updatable fields (whitelist):
 *   fermentation_hours, drying_start_date, ready_date, delivered_date,
 *   kg_green_actual, notes
 *
 * Status changes go through production-lots-update-status.
 */
const ALLOWED = new Set([
  'fermentation_hours', 'drying_start_date', 'ready_date', 'delivered_date',
  'kg_green_actual', 'notes',
]);

exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const lot_id = body.lot_id;
  if (!lot_id) return badReq('lot_id required', 'LOT_ID_REQUIRED');
  const fields = body.fields || {};

  const update = {};
  for (const k of Object.keys(fields)) {
    if (ALLOWED.has(k)) update[k] = fields[k];
  }
  if (Object.keys(update).length === 0) return badReq('No updatable fields provided', 'NO_FIELDS');

  const sb = getSupabase();
  const { data, error } = await sb
    .from('production_lots').update(update).eq('id', lot_id).select().maybeSingle();
  if (error) return serverErr('Update failed', error.message);
  if (!data) return notFound('Lot not found');
  return ok({ lot: data });
});
