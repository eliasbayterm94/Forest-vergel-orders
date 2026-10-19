'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { isMissingTable } = require('./_lib/costingData');
const { ok, badReq, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /monthly-closure-compute  (admin, forest)
 *   ?year=2026&month=10
 *
 * Absorbed vs. the mandate for one month, computed fresh from the
 * snapshots. Read-only: it does not write the close, so it can be
 * opened as often as needed before committing.
 *
 * Absorbed sums the snapshots' OWN COP amounts rather than
 * recomputing from tariffs, so a tariff revision cannot move a month
 * that already happened. Voided snapshots are excluded.
 *
 * A later correction to a dried weight does NOT re-cost the lot — by
 * decision, that gap lands here, in the mandate difference.
 */
exports.handler = requireAuth(['admin', 'forest'], async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const q = event.queryStringParameters || {};

  const year = Number(q.year);
  const month = Number(q.month);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    return badReq('year inválido', 'INVALID_YEAR');
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return badReq('month inválido', 'INVALID_MONTH');
  }

  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  const sb = getSupabase();

  const { data: snaps, error } = await sb
    .from('lot_cost_snapshots')
    .select(`id, production_lot_id, snapshot_date, source_kind,
             kg_input_net_total, kg_input_net_own, kg_input_net_purchased,
             kg_dried_output, purchase_cost_cop, t2_cost_cop, t1_cost_cop,
             total_cost_cop, cost_per_kg_dried, t1_per_kg_net, t2_per_kg_own_net`)
    .is('voided_at', null)
    .gte('snapshot_date', from)
    .lt('snapshot_date', to);
  if (error) {
    if (isMissingTable(error)) {
      return ok({ year, month, table_missing: true, computed: emptyTotals(), existing: null });
    }
    return serverErr('Failed to load snapshots', error.message);
  }

  const rows = snaps || [];
  const sum = (f) => rows.reduce((s, r) => s + Number(r[f] || 0), 0);
  const r2 = (n) => Math.round(n * 100) / 100;

  const computed = {
    snapshot_count:     rows.length,
    absorbed_t1_cop:    r2(sum('t1_cost_cop')),
    absorbed_t2_cop:    r2(sum('t2_cost_cop')),
    absorbed_total_cop: r2(sum('t1_cost_cop') + sum('t2_cost_cop')),
    // Purchase cost is NOT absorption: it is what was paid for cherry,
    // not the mandate the plant has to cover. Reported for context.
    purchase_cost_cop:  r2(sum('purchase_cost_cop')),
    total_lot_cost_cop: r2(sum('total_cost_cop')),
    kg_net_processed:   r2(sum('kg_input_net_total')),
    kg_net_own:         r2(sum('kg_input_net_own')),
    kg_net_purchased:   r2(sum('kg_input_net_purchased')),
    kg_dried_produced:  r2(sum('kg_dried_output')),
    // Blends inherit cost and carry no T1; counting their input as
    // processed cherry would double-count the month's volume.
    inherited_blend_count: rows.filter((r) => r.source_kind === 'inherited_blend').length,
  };
  computed.real_factor = computed.kg_net_processed > 0
    ? Math.round((computed.kg_dried_produced / computed.kg_net_processed) * 1e6) / 1e6 : null;
  computed.avg_cost_per_kg_dried = computed.kg_dried_produced > 0
    ? Math.round((computed.total_lot_cost_cop / computed.kg_dried_produced) * 10000) / 10000 : null;

  // An already-saved close for this month, so the UI can show what was
  // committed next to what the snapshots say now.
  let existing = null;
  const { data: saved, error: savedErr } = await sb
    .from('monthly_cost_closures').select('*').eq('year', year).eq('month', month).maybeSingle();
  if (!savedErr) existing = saved || null;

  return ok({ year, month, from, to, table_missing: false, computed, existing, snapshots: rows });
});

function emptyTotals() {
  return {
    snapshot_count: 0, absorbed_t1_cop: 0, absorbed_t2_cop: 0, absorbed_total_cop: 0,
    purchase_cost_cop: 0, total_lot_cost_cop: 0, kg_net_processed: 0, kg_net_own: 0,
    kg_net_purchased: 0, kg_dried_produced: 0, inherited_blend_count: 0,
    real_factor: null, avg_cost_per_kg_dried: null,
  };
}
