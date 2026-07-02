'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /operators-list
 *   ?include_inactive=true
 *
 * Operarios registrados (para el selector "¿Quién eres?" del
 * sidebar y la sección de /admin/config).
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const q = event.queryStringParameters || {};
  const includeInactive = q.include_inactive === 'true';

  const sb = getSupabase();
  let query = sb.from('operators')
    .select('id, name, active, created_at')
    .order('name', { ascending: true });
  if (!includeInactive) query = query.eq('active', true);

  const { data, error } = await query;
  if (error) return serverErr('Failed to load operators', error.message);
  return ok({ operators: data });
});
