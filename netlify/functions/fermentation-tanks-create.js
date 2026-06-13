'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, created, badReq, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /fermentation-tanks-create  (admin)
 * Body: { name, kind? }
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
  const kind = body.kind == null ? null : String(body.kind).trim() || null;

  const sb = getSupabase();
  const { data: existing, error: lookupErr } = await sb
    .from('fermentation_tanks').select('id, name, kind, active').eq('name', name).maybeSingle();
  if (lookupErr) return serverErr('Lookup failed', lookupErr.message);
  if (existing) {
    const upd = {};
    if (!existing.active) upd.active = true;
    if (kind != null && kind !== existing.kind) upd.kind = kind;
    if (Object.keys(upd).length > 0) {
      const { data: updated } = await sb
        .from('fermentation_tanks').update(upd).eq('id', existing.id)
        .select('id, name, kind, active').single();
      return ok({ fermentation_tank: updated, created: false });
    }
    return ok({ fermentation_tank: existing, created: false });
  }

  const { data, error } = await sb
    .from('fermentation_tanks').insert({ name, kind }).select('id, name, kind, active').single();
  if (error) return serverErr('Insert failed', error.message);
  return created({ fermentation_tank: data, created: true });
});
