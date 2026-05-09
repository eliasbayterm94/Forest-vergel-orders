'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, created, badReq, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /references-create  { name, variety_ids: [uuid], notes? }
 * Idempotent on name. Replaces variety links on subsequent calls if
 * `variety_ids` is provided AND the reference already exists with
 * different links — the caller decides whether to send variety_ids on
 * lookup-only calls.
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const name = (body && typeof body.name === 'string') ? body.name.trim() : '';
  if (!name) return badReq('Name required', 'NAME_REQUIRED');
  const variety_ids = Array.isArray(body.variety_ids) ? body.variety_ids : [];
  const notes = (typeof body.notes === 'string') ? body.notes : null;

  const sb = getSupabase();

  // Look up existing
  const { data: existing, error: lookupErr } = await sb
    .from('coffee_references').select('id, name, active, notes').eq('name', name).maybeSingle();
  if (lookupErr) return serverErr('Lookup failed', lookupErr.message);

  let refRow = existing;
  if (!refRow) {
    const { data, error } = await sb
      .from('coffee_references').insert({ name, notes }).select('id, name, active, notes').single();
    if (error) return serverErr('Insert failed', error.message);
    refRow = data;
  }

  if (variety_ids.length > 0) {
    // Replace links: delete then insert (the table is small per reference)
    const { error: delErr } = await sb
      .from('coffee_reference_varieties').delete().eq('reference_id', refRow.id);
    if (delErr) return serverErr('Failed to clear variety links', delErr.message);

    const rows = variety_ids.map((variety_id) => ({ reference_id: refRow.id, variety_id }));
    const { error: insErr } = await sb.from('coffee_reference_varieties').insert(rows);
    if (insErr) return serverErr('Failed to insert variety links', insErr.message);
  }

  // Return enriched view
  const { data: enriched, error: enErr } = await sb
    .from('coffee_references')
    .select(`id, name, active, notes,
             coffee_reference_varieties ( coffee_varieties ( id, name ) )`)
    .eq('id', refRow.id)
    .single();
  if (enErr) return serverErr('Failed to load reference', enErr.message);

  const reference = {
    id: enriched.id,
    name: enriched.name,
    active: enriched.active,
    notes: enriched.notes,
    varieties: (enriched.coffee_reference_varieties || [])
      .map((j) => j.coffee_varieties).filter(Boolean),
  };
  return existing ? ok({ reference, created: false }) : created({ reference, created: true });
});
