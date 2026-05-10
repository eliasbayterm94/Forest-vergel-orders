'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { PROCESS_TYPES } = require('./_lib/schema');
const { ok, created, badReq, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /references-create  { name, process_type?, fermentation_hours?, notes? }
 *
 * Idempotent on `name` (citext). On lookup-only call (just `name`), returns
 * the existing row unchanged. When `process_type` and/or
 * `fermentation_hours` are provided, the row is updated/created with them.
 *
 * The reference template carries process and fermentation defaults that
 * the demand form auto-fills when this reference is picked. Varieties are
 * NOT a reference-level concept anymore — they're chosen per demand order.
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const name = (body && typeof body.name === 'string') ? body.name.trim() : '';
  if (!name) return badReq('Name required', 'NAME_REQUIRED');

  const process_type = body.process_type ?? null;
  if (process_type !== null && !PROCESS_TYPES.includes(process_type)) {
    return badReq('Invalid process_type', 'INVALID_PROCESS_TYPE');
  }

  const fermentation_hours = body.fermentation_hours == null
    ? null
    : Number(body.fermentation_hours);
  if (fermentation_hours !== null && (!Number.isFinite(fermentation_hours) || fermentation_hours < 0)) {
    return badReq('fermentation_hours must be >= 0', 'INVALID_FERMENTATION');
  }

  const notes = (typeof body.notes === 'string') ? body.notes : null;

  const sb = getSupabase();

  // Look up existing
  const { data: existing, error: lookupErr } = await sb
    .from('coffee_references')
    .select('id, name, active, notes, process_type, fermentation_hours')
    .eq('name', name).maybeSingle();
  if (lookupErr) return serverErr('Lookup failed', lookupErr.message);

  let refRow = existing;
  if (!refRow) {
    const { data, error } = await sb
      .from('coffee_references')
      .insert({ name, process_type, fermentation_hours, notes })
      .select('id, name, active, notes, process_type, fermentation_hours')
      .single();
    if (error) return serverErr('Insert failed', error.message);
    refRow = data;
  } else if (process_type !== null || fermentation_hours !== null || notes !== null) {
    // Update what was provided (so an existing row's template can be revised).
    const update = {};
    if (process_type !== null) update.process_type = process_type;
    if (fermentation_hours !== null) update.fermentation_hours = fermentation_hours;
    if (notes !== null) update.notes = notes;
    const { data, error } = await sb
      .from('coffee_references')
      .update(update)
      .eq('id', refRow.id)
      .select('id, name, active, notes, process_type, fermentation_hours')
      .single();
    if (error) return serverErr('Update failed', error.message);
    refRow = data;
  }

  return existing && !process_type && !fermentation_hours
    ? ok({ reference: refRow, created: false })
    : created({ reference: refRow, created: !existing });
});
