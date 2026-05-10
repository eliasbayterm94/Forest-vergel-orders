'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase, clearLeadCache } = require('./_lib/supabase');
const { PROCESS_TYPES } = require('./_lib/schema');
const { ok, badReq, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /process-lead-times-update  (admin)
 * Body: { process_type, drying_days?, processing_days?, dried_to_green_divisor? }
 *
 * Edita una fila de process_lead_times. Todos los campos numericos son
 * opcionales — solo se actualizan los que vengan en el body.
 *
 * Bustea el cache del modulo (clearLeadCache) para que la proxima call
 * lea valores nuevos sin esperar cold start.
 */
const ALLOWED_FIELDS = ['drying_days', 'processing_days', 'dried_to_green_divisor'];

exports.handler = requireAuth(['admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const process_type = body.process_type;
  if (!PROCESS_TYPES.includes(process_type)) {
    return badReq('invalid process_type', 'INVALID_PROCESS_TYPE');
  }

  const update = {};
  for (const k of ALLOWED_FIELDS) {
    if (body[k] == null) continue;
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n <= 0) {
      return badReq(`${k} must be > 0`, 'INVALID_VALUE');
    }
    if (k === 'drying_days' || k === 'processing_days') {
      update[k] = Math.round(n);
    } else {
      update[k] = n;
    }
  }
  if (Object.keys(update).length === 0) {
    return badReq('No updatable fields provided', 'NO_FIELDS');
  }

  const sb = getSupabase();
  const { data, error } = await sb
    .from('process_lead_times')
    .update(update)
    .eq('process_type', process_type)
    .select()
    .maybeSingle();
  if (error) return serverErr('Failed to update process lead time', error.message);
  if (!data) return notFound(`process_type ${process_type} not found`);

  clearLeadCache();
  return ok({ row: data });
});
