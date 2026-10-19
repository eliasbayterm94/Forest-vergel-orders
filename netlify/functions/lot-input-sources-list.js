'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { getLotInputSources, isMissingTable } = require('./_lib/costingData');
const { ok, badReq, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /lot-input-sources-list
 *   ?lot_id=...              the sources of one lot
 *   ?missing=true            lots with no source recorded (admin, forest)
 *
 * The `missing` view is the safety net for the two-step flow: a lot
 * created without recording where its material came from cannot be
 * costed, and this is where it surfaces instead of being lost.
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const q = event.queryStringParameters || {};
  const sb = getSupabase();

  if (q.lot_id) {
    try {
      return ok({ input_sources: await getLotInputSources(sb, q.lot_id) });
    } catch (e) { return serverErr('Failed to load sources', e.message); }
  }

  if (q.missing === 'true') {
    // Only lots that are actually costable matter here: by-product
    // lots carry zero cost and need no source.
    const { data: lots, error: lotErr } = await sb
      .from('production_lots')
      .select('id, bache_code, lot_code, status, start_date, ready_date, lot_kind')
      .neq('status', 'Cancelled')
      .order('start_date', { ascending: false });
    if (lotErr) return serverErr('Failed to load lots', lotErr.message);

    const { data: srcs, error: srcErr } = await sb
      .from('lot_input_sources').select('production_lot_id');
    if (srcErr) {
      if (isMissingTable(srcErr)) return ok({ lots_without_source: [], table_missing: true });
      return serverErr('Failed to load sources', srcErr.message);
    }

    const withSource = new Set((srcs || []).map((s) => s.production_lot_id));
    const missing = (lots || [])
      .filter((l) => (l.lot_kind || 'main') === 'main' && !withSource.has(l.id));
    return ok({ lots_without_source: missing, table_missing: false });
  }

  return badReq('Indica lot_id o missing=true', 'FILTER_REQUIRED');
});
