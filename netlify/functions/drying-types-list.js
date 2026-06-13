'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /drying-types-list
 *   ?include_inactive=true  (admin only en práctica; el endpoint lo
 *                            expone igual y la UI filtra)
 *
 * Devuelve los tipos de secado para poblar selectores en los
 * prompts (promptDrying) y en /admin/config.
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const q = event.queryStringParameters || {};
  const includeInactive = q.include_inactive === 'true';

  const sb = getSupabase();
  let query = sb.from('drying_types')
    .select('id, name, kind, active, created_at')
    .order('kind', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true });
  if (!includeInactive) query = query.eq('active', true);

  const { data, error } = await query;
  if (error) return serverErr('Failed to load drying types', error.message);
  return ok({ drying_types: data });
});
