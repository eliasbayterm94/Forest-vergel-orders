'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { created, ok, badReq, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /suppliers-create  (admin)
 * Body: { name, kind: 'own'|'third_party', region?, notes? }
 *
 * Idempotent on name, like the other admin catalogues: an existing
 * supplier comes back and is reactivated if it was off.
 */
const KINDS = new Set(['own', 'third_party']);

exports.handler = requireAuth(['admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const name = (body && typeof body.name === 'string') ? body.name.trim() : '';
  if (!name) return badReq('name requerido', 'NAME_REQUIRED');
  if (name.length > 120) return badReq('name muy largo (máx 120)', 'NAME_TOO_LONG');

  const kind = body && body.kind;
  if (!KINDS.has(kind)) return badReq("kind debe ser 'own' o 'third_party'", 'KIND_INVALID');

  const region = body && body.region ? String(body.region).trim().slice(0, 80) || null : null;
  const notes  = body && body.notes  ? String(body.notes).trim().slice(0, 500) || null : null;

  const sb = getSupabase();

  const { data: existing, error: lookErr } = await sb
    .from('suppliers').select('id, name, kind, region, active').eq('name', name).maybeSingle();
  if (lookErr) return serverErr('Lookup failed', lookErr.message);
  if (existing) {
    if (!existing.active) {
      const { data: on, error: upErr } = await sb
        .from('suppliers').update({ active: true }).eq('id', existing.id)
        .select('id, name, kind, region, active').single();
      if (upErr) return serverErr('Reactivate failed', upErr.message);
      return ok({ supplier: on, created: false });
    }
    return ok({ supplier: existing, created: false });
  }

  const { data, error } = await sb
    .from('suppliers')
    .insert({ name, kind, region, notes, active: true })
    .select('id, name, kind, region, active, notes').single();
  if (error) return serverErr('Insert failed', error.message);
  return created({ supplier: data, created: true });
});
