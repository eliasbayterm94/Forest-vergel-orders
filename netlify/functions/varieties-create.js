'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, created, badReq, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /varieties-create  { name }
 * Idempotent: returns existing variety on case-insensitive name match.
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const name = (body && typeof body.name === 'string') ? body.name.trim() : '';
  if (!name) return badReq('Name required', 'NAME_REQUIRED');

  const sb = getSupabase();

  // citext-aware lookup (eq is case-insensitive on citext columns)
  const { data: existing, error: lookupErr } = await sb
    .from('coffee_varieties').select('id, name, active').eq('name', name).maybeSingle();
  if (lookupErr) return serverErr('Lookup failed', lookupErr.message);
  if (existing) return ok({ variety: existing, created: false });

  const { data, error } = await sb
    .from('coffee_varieties').insert({ name }).select('id, name, active').single();
  if (error) return serverErr('Insert failed', error.message);
  return created({ variety: data, created: true });
});
