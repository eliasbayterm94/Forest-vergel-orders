'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { PUBLIC_COLS, toPublicUser, isMissingTable } = require('./_lib/users');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /users-list  (admin)
 *   ?include_inactive=true
 *
 * Nunca devuelve password_hash — ver PUBLIC_COLS en _lib/users.
 */
exports.handler = requireAuth(['admin'], async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const q = event.queryStringParameters || {};
  const includeInactive = q.include_inactive === 'true';

  const sb = getSupabase();
  let query = sb.from('users')
    .select(PUBLIC_COLS)
    .order('username', { ascending: true });
  if (!includeInactive) query = query.eq('active', true);

  const { data, error } = await query;
  if (error) {
    // Migración 0048 sin aplicar: lista vacía en vez de romper /admin/config.
    if (isMissingTable(error)) return ok({ users: [], table_missing: true });
    return serverErr('Failed to load users', error.message);
  }
  return ok({ users: (data || []).map(toPublicUser), table_missing: false });
});
