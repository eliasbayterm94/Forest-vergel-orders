'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { isMissingTable } = require('./_lib/costingData');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /lot-costs-report  (admin, forest)
 *   ?from=YYYY-MM-DD &to=YYYY-MM-DD &include_voided=true
 *
 * Cost per kg of dried coffee by lot, with the lot's process and
 * origin attached, plus the real factor against each snapshot.
 *
 * Origin is derived from the snapshot's own kg split (own vs.
 * purchased) rather than re-reading the sources, so what the report
 * shows is exactly what was frozen.
 */
exports.handler = requireAuth(['admin', 'forest'], async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const q = event.queryStringParameters || {};
  const sb = getSupabase();

  let query = sb.from('lot_cost_snapshots').select('*').order('snapshot_date', { ascending: false });
  if (q.include_voided !== 'true') query = query.is('voided_at', null);
  if (q.from) query = query.gte('snapshot_date', q.from);
  if (q.to)   query = query.lte('snapshot_date', q.to);

  const { data: snaps, error } = await query;
  if (error) {
    if (isMissingTable(error)) return ok({ lots: [], table_missing: true });
    return serverErr('Failed to load snapshots', error.message);
  }
  const rows = snaps || [];
  if (rows.length === 0) return ok({ lots: [], table_missing: false });

  const { data: lots, error: lotErr } = await sb
    .from('production_lots')
    .select('id, bache_code, lot_code, blend_code, process_type, processing_stage, lot_kind, is_blend, ready_date, factor_rendimiento')
    .in('id', [...new Set(rows.map((r) => r.production_lot_id))]);
  if (lotErr) return serverErr('Failed to load lots', lotErr.message);
  const lotById = new Map((lots || []).map((l) => [l.id, l]));

  const out = rows.map((s) => {
    const l = lotById.get(s.production_lot_id) || {};
    const own = Number(s.kg_input_net_own || 0);
    const bought = Number(s.kg_input_net_purchased || 0);
    const origin = s.source_kind === 'inherited_blend' ? 'mezcla'
      : own > 0 && bought > 0 ? 'mixto'
      : own > 0 ? 'propio'
      : bought > 0 ? 'comprado'
      : 'subproducto';
    return {
      snapshot_id: s.id,
      lot_id: s.production_lot_id,
      code: l.bache_code || l.blend_code || l.lot_code || null,
      process_type: l.process_type || null,
      entry_stage: l.processing_stage || null,
      lot_kind: l.lot_kind || 'main',
      origin,
      source_kind: s.source_kind,
      snapshot_date: s.snapshot_date,
      kg_input_net_total: Number(s.kg_input_net_total || 0),
      kg_dried_output: Number(s.kg_dried_output || 0),
      real_factor: s.real_factor_dried_per_input == null ? null : Number(s.real_factor_dried_per_input),
      // The Colombian factor, carried along so the two are never confused.
      factor_rendimiento: l.factor_rendimiento == null ? null : Number(l.factor_rendimiento),
      purchase_cost_cop: Number(s.purchase_cost_cop || 0),
      t2_cost_cop: Number(s.t2_cost_cop || 0),
      t1_cost_cop: Number(s.t1_cost_cop || 0),
      total_cost_cop: Number(s.total_cost_cop || 0),
      cost_per_kg_dried: s.cost_per_kg_dried == null ? null : Number(s.cost_per_kg_dried),
      voided_at: s.voided_at || null,
    };
  });

  return ok({ lots: out, table_missing: false });
});
