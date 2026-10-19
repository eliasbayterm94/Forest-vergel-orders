'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
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
  let query = sb.from('suppliers')
    .select('id, name, kind, region, active, notes, created_at')
    .order('name', { ascending: true });
  if (q.include_inactive !== 'true') query = query.eq('active', true);

  const { data, error } = await query;
  if (error) {
    // Migration 0051 pending: empty list instead of a broken screen.
    if (isMissingTable(error)) return ok({ suppliers: [], table_missing: true });
    return serverErr('Failed to load suppliers', error.message);
  }
  return ok({ suppliers: data || [], table_missing: false });
});
