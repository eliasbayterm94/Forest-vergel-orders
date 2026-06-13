'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /fermentation-tanks-list
 *   ?include_inactive=true
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const q = event.queryStringParameters || {};
  const includeInactive = q.include_inactive === 'true';

  const sb = getSupabase();
  let query = sb.from('fermentation_tanks')
    .select('id, name, kind, active, created_at')
    .order('kind', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true });
  if (!includeInactive) query = query.eq('active', true);

  const { data, error } = await query;
  if (error) return serverErr('Failed to load fermentation tanks', error.message);
  return ok({ fermentation_tanks: data });
});
