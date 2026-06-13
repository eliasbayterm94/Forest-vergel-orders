'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/** POST /fermentation-types-update (admin)  Body: { id, fields: { name?, kind?, active? } } */
const ALLOWED = new Set(['name', 'kind', 'active']);

exports.handler = requireAuth(['admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const id = body.id;
  if (!id) return badReq('id required', 'ID_REQUIRED');
  const fields = body.fields || {};
  const update = {};
  for (const k of Object.keys(fields)) {
    if (!ALLOWED.has(k)) continue;
    update[k] = fields[k];
  }
  if (update.name != null) {
    update.name = String(update.name).trim();
    if (!update.name) return badReq('name cannot be empty', 'NAME_REQUIRED');
    if (update.name.length > 60) return badReq('name too long', 'NAME_TOO_LONG');
  }
  if (update.kind != null) update.kind = String(update.kind).trim() || null;
  if (update.active != null) update.active = !!update.active;
  if (Object.keys(update).length === 0) return badReq('No updatable fields', 'NO_FIELDS');

  const sb = getSupabase();
  const { data, error } = await sb
    .from('fermentation_types').update(update).eq('id', id)
    .select('id, name, kind, active').maybeSingle();
  if (error) return serverErr('Update failed', error.message);
  if (!data) return notFound('Fermentation type not found');
  return ok({ fermentation_type: data });
});
