'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, created, badReq, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /monthly-closure-save  (admin)
 * Body: { year, month, actual_mandate_cop?, byproduct_revenue_cop?, notes? }
 *
 * Commits the month. The absorbed figures are recomputed here from the
 * snapshots rather than taken from the request, so a stale screen
 * cannot save numbers that no longer match the data.
 *
 * Re-saving the same month updates it: ops may key the real mandate in
 * later, or correct it. What never changes is the absorbed side — that
 * comes from frozen snapshots.
 */
exports.handler = requireAuth(['admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const year = Number(body && body.year);
  const month = Number(body && body.month);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return badReq('year inválido', 'INVALID_YEAR');
  if (!Number.isInteger(month) || month < 1 || month > 12) return badReq('month inválido', 'INVALID_MONTH');

  const optCop = (v, label) => {
    if (v == null || v === '') return { value: null };
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { err: `${label} debe ser un número >= 0` };
    return { value: Math.round(n * 100) / 100 };
  };
  const mandate = optCop(body.actual_mandate_cop, 'actual_mandate_cop');
  if (mandate.err) return badReq(mandate.err, 'INVALID_MANDATE');
  const bpRev = optCop(body.byproduct_revenue_cop, 'byproduct_revenue_cop');
  if (bpRev.err) return badReq(bpRev.err, 'INVALID_BYPRODUCT_REVENUE');

  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  const sb = getSupabase();

  // Recomputed here on purpose: never trust totals coming from a screen.
  const { data: snaps, error } = await sb
    .from('lot_cost_snapshots')
    .select('t1_cost_cop, t2_cost_cop, kg_input_net_total, kg_dried_output')
    .is('voided_at', null)
    .gte('snapshot_date', from)
    .lt('snapshot_date', to);
  if (error) return serverErr('Failed to load snapshots', error.message);

  const rows = snaps || [];
  const r2 = (n) => Math.round(n * 100) / 100;
  const sum = (f) => rows.reduce((s, r) => s + Number(r[f] || 0), 0);

  const payload = {
    year, month,
    absorbed_t1_cop: r2(sum('t1_cost_cop')),
    absorbed_t2_cop: r2(sum('t2_cost_cop')),
    actual_mandate_cop: mandate.value,
    byproduct_revenue_cop: bpRev.value,
    snapshot_count: rows.length,
    kg_net_processed: r2(sum('kg_input_net_total')),
    kg_dried_produced: r2(sum('kg_dried_output')),
    closed_at: new Date().toISOString(),
    closed_by: (session && (session.username || session.role)) || null,
    notes: body.notes ? String(body.notes).trim().slice(0, 1000) || null : null,
  };

  const { data: existing, error: lookErr } = await sb
    .from('monthly_cost_closures').select('id').eq('year', year).eq('month', month).maybeSingle();
  if (lookErr) return serverErr('Lookup failed', lookErr.message);

  if (existing) {
    const { data, error: upErr } = await sb
      .from('monthly_cost_closures').update(payload).eq('id', existing.id)
      .select('*').single();
    if (upErr) return serverErr('Update failed', upErr.message);
    return ok({ closure: data, created: false });
  }

  const { data, error: insErr } = await sb
    .from('monthly_cost_closures').insert(payload).select('*').single();
  if (insErr) return serverErr('Insert failed', insErr.message);
  return created({ closure: data, created: true });
});
