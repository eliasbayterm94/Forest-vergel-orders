'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { cherryToGreen } = require('./_lib/cherryConversion');
const { PROCESS_TYPES } = require('./_lib/schema');
const { created, badReq, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /production-lots-create  (finca, admin)
 * Body:
 *   reference_id           uuid
 *   process_type           one of PROCESS_TYPES
 *   kg_cherry_input        number > 0
 *   start_date             'YYYY-MM-DD'
 *   fermentation_hours     number >= 0 (optional)
 *   variety_ids            [uuid] (optional)
 *   notes                  string (optional)
 *
 * Lot starts in status InFermentation. kg_green_expected is computed
 * from kg_cherry_input via the cherry-conversion utility.
 */
exports.handler = requireAuth(['finca', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const errors = [];
  const reference_id = body.reference_id;
  const process_type = body.process_type;
  const kg_cherry_input = Number(body.kg_cherry_input);
  const start_date = body.start_date;
  const fermentation_hours = body.fermentation_hours == null ? null : Number(body.fermentation_hours);
  const variety_ids = Array.isArray(body.variety_ids) ? body.variety_ids : [];
  const notes = body.notes == null ? null : String(body.notes);

  if (!reference_id) errors.push('reference_id required');
  if (!PROCESS_TYPES.includes(process_type)) errors.push('process_type invalid');
  if (!Number.isFinite(kg_cherry_input) || kg_cherry_input <= 0) errors.push('kg_cherry_input must be > 0');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date || '')) errors.push('start_date must be YYYY-MM-DD');
  if (fermentation_hours != null && (!Number.isFinite(fermentation_hours) || fermentation_hours < 0))
    errors.push('fermentation_hours must be >= 0');
  if (errors.length) return badReq(errors.join('; '), 'VALIDATION_ERROR');

  const sb = getSupabase();
  const { data: refRow, error: refErr } = await sb
    .from('coffee_references').select('id, active').eq('id', reference_id).maybeSingle();
  if (refErr) return serverErr('Reference lookup failed', refErr.message);
  if (!refRow || !refRow.active) return badReq('Unknown or inactive reference', 'INVALID_REFERENCE');

  const kg_green_expected = cherryToGreen(kg_cherry_input);

  const { data: lot, error: insErr } = await sb
    .from('production_lots').insert({
      reference_id,
      process_type,
      kg_cherry_input,
      kg_green_expected,
      fermentation_hours,
      start_date,
      notes,
      created_by: session.role,
    }).select().single();
  if (insErr) return serverErr('Failed to create lot', insErr.message);

  if (variety_ids.length > 0) {
    const rows = variety_ids.map((variety_id) => ({ production_lot_id: lot.id, variety_id }));
    const { error: vErr } = await sb.from('production_lot_varieties').insert(rows);
    if (vErr) return serverErr('Failed to link varieties', vErr.message);
  }

  return created({ lot });
});
