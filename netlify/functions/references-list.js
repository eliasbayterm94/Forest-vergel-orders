'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /references-list — returns references with linked variety ids/names.
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const sb = getSupabase();
  const { data, error } = await sb
    .from('coffee_references')
    .select(`
      id, name, active, notes,
      coffee_reference_varieties (
        variety_id,
        coffee_varieties ( id, name )
      )
    `)
    .eq('active', true)
    .order('name', { ascending: true });
  if (error) return serverErr('Failed to load references', error.message);

  const references = (data || []).map((r) => ({
    id: r.id,
    name: r.name,
    active: r.active,
    notes: r.notes,
    varieties: (r.coffee_reference_varieties || [])
      .map((j) => j.coffee_varieties)
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));
  return ok({ references });
});
