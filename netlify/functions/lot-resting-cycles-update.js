'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');
const { validateDryingLocations } = require('./_lib/dryingTypes');

/**
 * POST /lot-resting-cycles-update  (finca, admin)
 * Body: { cycle_id, fields }
 * Updatable fields:
 *   start_date, end_date,
 *   start_humidity, end_humidity,
 *   drying_locations_after (text[] validado contra drying_types activos)
 *
 * Para correcciones de captura desde el historial del bache.
 */
const DATE_FIELDS = new Set(['start_date', 'end_date']);
const HUM_FIELDS  = new Set(['start_humidity', 'end_humidity']);
const ARR_FIELDS  = new Set(['drying_locations_after']);
const ALLOWED = new Set([...DATE_FIELDS, ...HUM_FIELDS, ...ARR_FIELDS]);

exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const cycle_id = body.cycle_id;
  if (!cycle_id) return badReq('cycle_id required', 'CYCLE_ID_REQUIRED');
  const fields = body.fields || {};
  const sb = getSupabase();

  const update = {};
  for (const k of Object.keys(fields)) {
    if (!ALLOWED.has(k)) continue;
    const v = fields[k];
    if (DATE_FIELDS.has(k)) {
      if (v != null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        return badReq(`${k} must be YYYY-MM-DD`, 'INVALID_DATE');
      }
      update[k] = v;
    } else if (HUM_FIELDS.has(k)) {
      if (v == null || v === '') { update[k] = null; continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 8 || n > 40) {
        return badReq(`${k} debe estar entre 8 y 40`, 'INVALID_HUMIDITY');
      }
      update[k] = Math.round(n * 100) / 100;
    } else if (k === 'drying_locations_after') {
      if (!Array.isArray(v)) {
        return badReq('drying_locations_after must be array', 'INVALID_ARRAY');
      }
      let result;
      try { result = await validateDryingLocations(sb, v); }
      catch (e) { return serverErr('Drying types lookup failed', e.message); }
      if (!result.ok) return badReq(result.message, 'INVALID_LOCATIONS');
      update.drying_locations_after = result.locations;
    }
  }
  if (Object.keys(update).length === 0) return badReq('No updatable fields provided', 'NO_FIELDS');

  const { data, error } = await sb
    .from('lot_resting_cycles').update(update).eq('id', cycle_id).select().maybeSingle();
  if (error) return serverErr('Update failed', error.message);
  if (!data) return notFound('Cycle not found');
  return ok({ cycle: data });
});
