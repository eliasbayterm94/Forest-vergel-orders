'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /lot-resting-cycles-update  (finca, admin)
 * Body: { cycle_id, fields }
 * Updatable fields: start_date, end_date
 *
 * Sólo para correcciones de captura. Cambiar humedad/end_reason
 * requeriría más cuidado (afectan reglas de alerta y trazabilidad),
 * por ahora no se permite.
 */
const ALLOWED = new Set(['start_date', 'end_date']);

exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const cycle_id = body.cycle_id;
  if (!cycle_id) return badReq('cycle_id required', 'CYCLE_ID_REQUIRED');
  const fields = body.fields || {};

  const update = {};
  for (const k of Object.keys(fields)) {
    if (!ALLOWED.has(k)) continue;
    const v = fields[k];
    if (v != null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return badReq(`${k} must be YYYY-MM-DD`, 'INVALID_DATE');
    }
    update[k] = v;
  }
  if (Object.keys(update).length === 0) return badReq('No updatable fields provided', 'NO_FIELDS');

  const sb = getSupabase();
  const { data, error } = await sb
    .from('lot_resting_cycles').update(update).eq('id', cycle_id).select().maybeSingle();
  if (error) return serverErr('Update failed', error.message);
  if (!data) return notFound('Cycle not found');
  return ok({ cycle: data });
});
