'use strict';

/**
 * Database access for costing. Keeps the queries in one place so the
 * pure modules (lotCosting, costPool) stay pure and testable.
 *
 * Every read here tolerates the costing migrations (0051/0052) not
 * being applied yet: it returns an empty/neutral result instead of
 * throwing, so the app keeps working while the migration is pending.
 */

const { computePoolState, receptionNetKg, byproductRate, receptionAmountPaid } = require('./costPool');

/** A missing table means the costing migrations are not applied yet. */
function isMissingTable(error) {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  return /does not exist|could not find the table/i.test(error.message || '');
}

/**
 * The tariff version in force on `ymd`: the greatest effective_from
 * that is not in the future relative to that date.
 * Returns null when no version covers the date — the caller must then
 * refuse to cost rather than invent a rate.
 */
async function getParamsInForce(sb, ymd) {
  const { data, error } = await sb
    .from('costing_parameters')
    .select('*')
    .lte('effective_from', ymd)
    .order('effective_from', { ascending: false })
    .limit(1);
  if (error) {
    if (isMissingTable(error)) return null;
    throw new Error(`Costing parameters lookup failed: ${error.message}`);
  }
  return (data && data[0]) || null;
}

/** By-product rows grouped by the reception they came from. */
async function byproductsByReception(sb, receptionIds) {
  const out = new Map();
  if (!receptionIds || receptionIds.length === 0) return out;
  const { data, error } = await sb
    .from('lot_byproducts')
    .select('id, source_reception_id, kg, measurement, measured_stage, kind, separated_on, byproduct_lot_id')
    .in('source_reception_id', receptionIds);
  if (error) {
    if (isMissingTable(error)) return out;
    throw new Error(`By-product lookup failed: ${error.message}`);
  }
  for (const b of data || []) {
    if (!out.has(b.source_reception_id)) out.set(b.source_reception_id, []);
    out.get(b.source_reception_id).push(b);
  }
  return out;
}

/**
 * Receptions enriched with derived net kg and the floater/discount
 * comparison. `filters` accepts { pool_key, supplier_id, from, to }.
 */
const RECEPTION_CORE_COLS = `id, reception_code, supplier_id, received_date, entry_stage,
             kg_gross, price_per_kg, discount_pct, amount_paid_cop, pool_key,
             notes, created_by, created_at`;
// Added by migration 0053. Migrations here are applied by hand, so the
// read falls back to the core columns rather than failing the screen.
const RECEPTION_WEIGHING_COLS = `, kg_scale_gross, sacks_count, tare_per_sack_kg,
             cherry_to_pulped_ratio, brix_pct, ph`;

async function listReceptions(sb, filters = {}) {
  const build = (cols) => {
    let q = sb.from('cherry_receptions')
      .select(cols)
      .order('received_date', { ascending: false });
    if (filters.pool_key)    q = q.eq('pool_key', filters.pool_key);
    if (filters.supplier_id) q = q.eq('supplier_id', filters.supplier_id);
    if (filters.from)        q = q.gte('received_date', filters.from);
    if (filters.to)          q = q.lte('received_date', filters.to);
    return q;
  };

  let { data, error } = await build(RECEPTION_CORE_COLS + RECEPTION_WEIGHING_COLS);
  if (error && /kg_scale_gross|sacks_count|tare_per_sack_kg|cherry_to_pulped_ratio|brix_pct/.test(error.message || '')) {
    ({ data, error } = await build(RECEPTION_CORE_COLS));
  }
  if (error) {
    if (isMissingTable(error)) return { receptions: [], table_missing: true };
    throw new Error(`Receptions lookup failed: ${error.message}`);
  }

  const rows = data || [];
  const bpMap = await byproductsByReception(sb, rows.map((r) => r.id));

  const receptions = rows.map((r) => {
    const bps = bpMap.get(r.id) || [];
    return {
      ...r,
      // Derived when the generated column did not come back, so a
      // missing amount can never cost the coffee at zero.
      amount_paid_cop: receptionAmountPaid(r),
      kg_net: receptionNetKg(r, bps),
      byproducts: bps,
      byproduct_summary: byproductRate(r, bps),
    };
  });
  return { receptions, table_missing: false };
}

/**
 * Current state of one pool: replays its receptions (net) and the
 * draws against it, chronologically.
 */
async function getPoolState(sb, poolKey) {
  if (!poolKey) throw new Error('poolKey required');

  const { receptions, table_missing } = await listReceptions(sb, { pool_key: poolKey });
  if (table_missing) {
    return { pool_key: poolKey, table_missing: true, ...computePoolState({}) };
  }

  const { data: draws, error } = await sb
    .from('lot_input_sources')
    .select('id, kg, drawn_at, production_lot_id')
    .eq('pool_key', poolKey);
  if (error && !isMissingTable(error)) {
    throw new Error(`Draws lookup failed: ${error.message}`);
  }

  const state = computePoolState({
    receptions: receptions.map((r) => ({
      id: r.id, received_date: r.received_date,
      kg_net: r.kg_net, amount_paid_cop: r.amount_paid_cop,
    })),
    draws: (draws || []).map((d) => ({ id: d.id, drawn_at: d.drawn_at, kg: d.kg })),
  });

  return { pool_key: poolKey, table_missing: false, ...state };
}

/** Every pool key that has at least one reception. */
async function listPoolKeys(sb) {
  const { data, error } = await sb
    .from('cherry_receptions').select('pool_key').not('pool_key', 'is', null);
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(`Pool keys lookup failed: ${error.message}`);
  }
  return [...new Set((data || []).map((r) => r.pool_key).filter(Boolean))].sort();
}

/** The input sources of a lot, ready to hand to computeLotCost. */
async function getLotInputSources(sb, lotId) {
  const { data, error } = await sb
    .from('lot_input_sources')
    .select('id, reception_id, pool_key, kg, entry_stage, cost_basis, purchase_cost_per_kg, drawn_at')
    .eq('production_lot_id', lotId)
    .order('drawn_at', { ascending: true });
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(`Lot sources lookup failed: ${error.message}`);
  }
  return data || [];
}

/** The live (non-voided) snapshot of a lot, if it has one. */
async function getLiveSnapshot(sb, lotId) {
  const { data, error } = await sb
    .from('lot_cost_snapshots')
    .select('*')
    .eq('production_lot_id', lotId)
    .is('voided_at', null)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    throw new Error(`Snapshot lookup failed: ${error.message}`);
  }
  return data || null;
}

module.exports = {
  isMissingTable,
  getParamsInForce,
  byproductsByReception,
  listReceptions,
  getPoolState,
  listPoolKeys,
  getLotInputSources,
  getLiveSnapshot,
};
