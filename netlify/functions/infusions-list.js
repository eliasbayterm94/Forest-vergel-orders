'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /infusions-list
 * Catalogo de infusiones disponibles para asociar a un lote.
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const sb = getSupabase();
  const { data, error } = await sb
    .from('infusions')
    .select('id, name, active')
    .eq('active', true)
    .order('name', { ascending: true });
  if (error) return serverErr('Failed to load infusions', error.message);
  return ok({ infusions: data || [] });
});
