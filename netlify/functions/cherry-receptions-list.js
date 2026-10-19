'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { listReceptions } = require('./_lib/costingData');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /cherry-receptions-list  (finca, admin, forest)
 *   ?pool_key= &supplier_id= &from= &to=
 *
 * Each row carries its derived net kg, its by-product rows and the
 * floater-vs-discount comparison, so the screen never has to compute
 * money itself.
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const q = event.queryStringParameters || {};
  const sb = getSupabase();

  try {
    const { receptions, table_missing } = await listReceptions(sb, {
      pool_key:    q.pool_key || undefined,
      supplier_id: q.supplier_id || undefined,
      from:        q.from || undefined,
      to:          q.to || undefined,
    });
    return ok({ receptions, table_missing });
  } catch (e) {
    return serverErr('Failed to load receptions', e.message);
  }
});
