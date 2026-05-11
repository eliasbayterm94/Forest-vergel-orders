'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, created, badReq, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /infusions-create  (finca, admin)
 * Body: { name }
 * Idempotente sobre name (case-sensitive, citext-free): si ya existe
 * devuelve la fila existente.
 */
exports.handler = requireAuth(['finca', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const name = (body && typeof body.name === 'string') ? body.name.trim() : '';
  if (!name) return badReq('name required', 'NAME_REQUIRED');
  if (name.length > 60) return badReq('name too long (max 60)', 'NAME_TOO_LONG');

  const sb = getSupabase();
  const { data: existing } = await sb
    .from('infusions').select('id, name, active').eq('name', name).maybeSingle();
  if (existing) return ok({ infusion: existing, created: false });

  const { data, error } = await sb
    .from('infusions').insert({ name, created_by: session.role })
    .select('id, name, active').single();
  if (error) return serverErr('Failed to create infusion', error.message);
  return created({ infusion: data, created: true });
});
