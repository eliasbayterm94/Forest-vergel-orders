'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const sb = getSupabase();
  const { data, error } = await sb
    .from('coffee_varieties')
    .select('id, name, active')
    .eq('active', true)
    .order('name', { ascending: true });
  if (error) return serverErr('Failed to load varieties', error.message);
  return ok({ varieties: data });
});
