'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { isMissingTable } = require('./_lib/costingData');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /monthly-closures-list  (admin, forest)
 *   ?year=2026
 *
 * Saved closes plus the running year-to-date, in COP and as a share of
 * the mandate — which is how the difference is actually read.
 */
exports.handler = requireAuth(['admin', 'forest'], async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const q = event.queryStringParameters || {};

  const sb = getSupabase();
  let query = sb.from('monthly_cost_closures').select('*')
    .order('year', { ascending: false }).order('month', { ascending: false });
  if (q.year) query = query.eq('year', Number(q.year));

  const { data, error } = await query;
  if (error) {
    if (isMissingTable(error)) return ok({ closures: [], ytd: null, table_missing: true });
    return serverErr('Failed to load closures', error.message);
  }

  const rows = data || [];
  // Year to date: only months with a real mandate keyed in, since the
  // difference is meaningless without it.
  const withMandate = rows.filter((r) => r.actual_mandate_cop != null);
  const sum = (f, src = rows) => src.reduce((s, r) => s + Number(r[f] || 0), 0);
  const r2 = (n) => Math.round(n * 100) / 100;

  const absorbed = r2(sum('absorbed_total_cop', withMandate));
  const mandate = r2(sum('actual_mandate_cop', withMandate));

  const ytd = withMandate.length === 0 ? null : {
    months: withMandate.length,
    absorbed_total_cop: absorbed,
    actual_mandate_cop: mandate,
    mandate_difference_cop: r2(mandate - absorbed),
    // The share of the mandate the difference represents: the number
    // ops reads, not the raw pesos.
    difference_pct_of_mandate: mandate > 0 ? Math.round(((mandate - absorbed) / mandate) * 10000) / 10000 : null,
    byproduct_revenue_cop: r2(sum('byproduct_revenue_cop', withMandate)),
    kg_net_processed: r2(sum('kg_net_processed', rows)),
    kg_dried_produced: r2(sum('kg_dried_produced', rows)),
  };

  return ok({ closures: rows, ytd, table_missing: false });
});
