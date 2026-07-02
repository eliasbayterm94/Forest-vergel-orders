'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, created, badReq, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /operators-create  (admin)
 * Body: { name }
 *
 * Idempotente: si existe (case-insensitive), devuelve el existente.
 * Si estaba inactivo, lo reactiva.
 */
exports.handler = requireAuth(['admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const name = (body && typeof body.name === 'string') ? body.name.trim() : '';
  if (!name) return badReq('name required', 'NAME_REQUIRED');
  if (name.length > 60) return badReq('name too long (max 60)', 'NAME_TOO_LONG');

  const sb = getSupabase();
  const { data: existing, error: lookupErr } = await sb
    .from('operators').select('id, name, active').eq('name', name).maybeSingle();
  if (lookupErr) return serverErr('Lookup failed', lookupErr.message);
  if (existing) {
    if (!existing.active) {
      const { data: updated } = await sb
        .from('operators').update({ active: true }).eq('id', existing.id)
        .select('id, name, active').single();
      return ok({ operator: updated, created: false });
    }
    return ok({ operator: existing, created: false });
  }

  const { data, error } = await sb
    .from('operators').insert({ name }).select('id, name, active').single();
  if (error) return serverErr('Insert failed', error.message);
  return created({ operator: data, created: true });
});
