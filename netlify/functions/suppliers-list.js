'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { isMissingColumn } = require('./_lib/costingData');
const { isMissingTable } = require('./_lib/costingData');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /suppliers-list
 *   ?include_inactive=true
 *
 * Read-only for every role: the lot form needs the list to say where
 * its material came from.
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const q = event.queryStringParameters || {};

  const sb = getSupabase();
  const CORE = 'id, name, kind, region, active, notes, created_at';
  const build = (cols) => {
    let query = sb.from('suppliers').select(cols).order('name', { ascending: true });
    if (q.include_inactive !== 'true') query = query.eq('active', true);
    return query;
  };

  // The franchise arrives with migration 0054. Falling back keeps the
  // reception screen alive if the code lands before the SQL — without
  // suppliers it cannot register anything at all.
  let { data, error } = await build(`${CORE}, floater_franchise_pct`);
  if (error && isMissingColumn(error, ['floater_franchise_pct'])) {
    ({ data, error } = await build(CORE));
  }
  if (error) {
    // Migration 0051 pending: empty list instead of a broken screen.
    if (isMissingTable(error)) return ok({ suppliers: [], table_missing: true });
    return serverErr('Failed to load suppliers', error.message);
  }
  return ok({ suppliers: data || [], table_missing: false });
});
