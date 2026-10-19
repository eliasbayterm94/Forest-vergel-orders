'use strict';

/**
 * Creating, voiding and sharing out cost snapshots.
 *
 * THE RULE THAT GOVERNS THIS FILE
 * Costing must never break the operation. Closing a batch, undoing a
 * stage or splitting a lot has to succeed whether or not tariffs are
 * configured, the migrations are applied, or the material source was
 * recorded. Every function here returns a RESULT describing what it
 * did or why it did nothing — it does not throw at the caller, and the
 * caller surfaces it as information, never as a failure.
 *
 * See migrations 0051/0052 and _lib/lotCosting.js.
 */

const { computeLotCost, computeBlendCost, splitSnapshotCost } = require('./lotCosting');
const { getParamsInForce, getLotInputSources, getLiveSnapshot, isMissingTable } = require('./costingData');

/** Shape every function here returns, so callers read one thing. */
const skipped = (reason, message) => ({ ok: false, skipped: reason, message });
const done = (snapshot, extra = {}) => ({ ok: true, snapshot, ...extra });

/**
 * Cost a lot at its dry exit and freeze the result.
 *
 * Idempotent: a lot that already has a live snapshot is left alone, so
 * a reprocess (Resting → Drying → Ready again) never charges twice.
 */
async function snapshotLotAtDryExit(sb, { lotId, readyDate, actor = null }) {
  // Already costed: a second dry exit must not charge the lot again.
  let existing;
  try { existing = await getLiveSnapshot(sb, lotId); }
  catch (e) { return skipped('lookup_failed', e.message); }
  if (existing) {
    return skipped('already_costed',
      'El bache ya tiene un costo congelado; una segunda salida en seco no lo recostea.');
  }

  const { data: lot, error: lotErr } = await sb
    .from('production_lots')
    .select('id, bache_code, lot_code, kg_dried_output, lot_kind, is_blend, ready_date')
    .eq('id', lotId).maybeSingle();
  if (lotErr) return skipped('lookup_failed', lotErr.message);
  if (!lot) return skipped('lot_not_found', 'Bache no encontrado.');

  const snapshotDate = readyDate || lot.ready_date || new Date().toISOString().slice(0, 10);
  const dried = Number(lot.kg_dried_output || 0);

  // A blend INHERITS the weighted average of its components. T1 is
  // never re-applied: the cherry already paid for processing when each
  // component was costed, and charging it again would double-count.
  if (lot.is_blend) {
    return snapshotBlend(sb, { lot, snapshotDate, dried, actor });
  }

  let sources;
  try { sources = await getLotInputSources(sb, lotId); }
  catch (e) { return skipped('lookup_failed', e.message); }
  if (!sources || sources.length === 0) {
    return skipped('no_sources',
      'No se registró de dónde salió la materia, así que el bache no se puede costear. '
      + 'Complétalo y vuelve a intentar.');
  }

  let params;
  try { params = await getParamsInForce(sb, snapshotDate); }
  catch (e) { return skipped('lookup_failed', e.message); }
  if (!params) {
    return skipped('no_tariff',
      `No hay tarifas de costeo vigentes al ${snapshotDate}. Defínelas en /admin/config.`);
  }

  let computed;
  try {
    computed = computeLotCost({ sources, kgDriedOutput: dried, params });
  } catch (e) {
    return skipped('compute_failed', e.message);
  }

  return insertSnapshot(sb, {
    lotId, snapshotDate, params, computed, sourceKind: 'computed', actor,
  });
}

/** Weighted average of a blend's components, by kg contributed. */
async function snapshotBlend(sb, { lot, snapshotDate, dried, actor }) {
  const { data: comps, error } = await sb
    .from('lot_blend_components')
    .select('source_lot_id, kg_dried_used')
    .eq('blend_lot_id', lot.id);
  if (error) return skipped('lookup_failed', error.message);
  if (!comps || comps.length === 0) {
    return skipped('no_components', 'La mezcla no tiene componentes registrados.');
  }

  const components = [];
  const uncosted = [];
  for (const c of comps) {
    let snap;
    try { snap = await getLiveSnapshot(sb, c.source_lot_id); }
    catch (e) { return skipped('lookup_failed', e.message); }
    if (!snap || snap.cost_per_kg_dried == null) {
      uncosted.push(c.source_lot_id);
      continue;
    }
    components.push({
      kg_dried_used: Number(c.kg_dried_used),
      cost_per_kg_dried: Number(snap.cost_per_kg_dried),
    });
  }

  // Partial costing would understate the blend, so refuse rather than
  // average over the components that happen to be costed.
  if (uncosted.length > 0) {
    return skipped('components_uncosted',
      `${uncosted.length} bache(s) de la mezcla no están costeados todavía. `
      + 'Cuesta primero los padres para que la mezcla herede su costo.');
  }

  let blend;
  try {
    blend = computeBlendCost({ components, kgDriedOutput: dried || null });
  } catch (e) {
    return skipped('compute_failed', e.message);
  }

  // The blend's cost is inherited whole. It is recorded as purchase
  // cost with zero T1 so the monthly close — which sums T1 and T2 —
  // cannot count this coffee's processing a second time.
  const { data, error: insErr } = await sb
    .from('lot_cost_snapshots')
    .insert({
      production_lot_id: lot.id,
      costing_parameters_id: null,
      t1_per_kg_net: 0,
      t2_per_kg_own_net: 0,
      snapshot_date: snapshotDate,
      kg_input_net_total: blend.kg_dried_used,
      kg_input_net_own: 0,
      kg_input_net_purchased: 0,
      kg_dried_output: blend.kg_dried_output,
      real_factor_dried_per_input: blend.kg_dried_used > 0
        ? Math.round((blend.kg_dried_output / blend.kg_dried_used) * 1e6) / 1e6 : null,
      purchase_cost_cop: blend.total_cost_cop,
      t2_cost_cop: 0,
      t1_cost_cop: 0,
      source_kind: 'inherited_blend',
      notes: 'Costo heredado de los componentes (promedio ponderado). T1 no se reaplica.',
      created_by: actor,
    })
    .select('*').single();
  if (insErr) {
    if (isMissingTable(insErr)) return skipped('migration_pending', 'Migración 0052 sin aplicar.');
    return skipped('insert_failed', insErr.message);
  }
  return done(data, { inherited: true });
}

async function insertSnapshot(sb, { lotId, snapshotDate, params, computed, sourceKind, actor, notes = null, sourceSnapshotId = null }) {
  const { data, error } = await sb
    .from('lot_cost_snapshots')
    .insert({
      production_lot_id: lotId,
      costing_parameters_id: params ? params.id : null,
      t1_per_kg_net: computed.t1_per_kg_net,
      t2_per_kg_own_net: computed.t2_per_kg_own_net,
      snapshot_date: snapshotDate,
      kg_input_net_total: computed.kg_input_net_total,
      kg_input_net_own: computed.kg_input_net_own,
      kg_input_net_purchased: computed.kg_input_net_purchased,
      kg_dried_output: computed.kg_dried_output,
      real_factor_dried_per_input: computed.real_factor_dried_per_input,
      purchase_cost_cop: computed.purchase_cost_cop,
      t2_cost_cop: computed.t2_cost_cop,
      t1_cost_cop: computed.t1_cost_cop,
      source_kind: sourceKind,
      source_snapshot_id: sourceSnapshotId,
      notes,
      created_by: actor,
    })
    .select('*').single();
  if (error) {
    if (isMissingTable(error)) return skipped('migration_pending', 'Migración 0052 sin aplicar.');
    // The unique index on one live snapshot per lot: a concurrent close.
    if (/uq_lot_cost_snapshots_one_live|duplicate key/i.test(error.message || '')) {
      return skipped('already_costed', 'El bache ya quedó costeado por otra operación simultánea.');
    }
    return skipped('insert_failed', error.message);
  }
  return done(data);
}

/**
 * Void a lot's snapshot when its dry exit is undone.
 * Snapshots are never deleted — the record stays.
 */
async function voidLotSnapshot(sb, { lotId, reason, actor = null }) {
  let snap;
  try { snap = await getLiveSnapshot(sb, lotId); }
  catch (e) { return skipped('lookup_failed', e.message); }
  if (!snap) return skipped('no_snapshot', 'El bache no tenía costo congelado.');

  const { data, error } = await sb
    .from('lot_cost_snapshots')
    .update({
      voided_at: new Date().toISOString(),
      voided_reason: String(reason || 'Se deshizo la salida en seco').slice(0, 500),
      voided_by: actor,
    })
    .eq('id', snap.id)
    .select('*').single();
  if (error) return skipped('void_failed', error.message);
  return done(data, { voided: true });
}

/**
 * Share a costed parent's snapshot out to a split child.
 *
 * A split moves mass, it does not process coffee: cost per kg is
 * identical on both sides. The parent's frozen snapshot is voided and
 * two new ones are written (remainder + child), both pointing at the
 * original, so the trail shows exactly what happened.
 */
async function splitLotSnapshot(sb, { parentId, childId, ratio, actor = null }) {
  let snap;
  try { snap = await getLiveSnapshot(sb, parentId); }
  catch (e) { return skipped('lookup_failed', e.message); }
  if (!snap) return skipped('no_snapshot', 'El bache padre no estaba costeado; no hay costo que repartir.');

  let parts;
  try { parts = splitSnapshotCost({ snapshot: snap, ratio }); }
  catch (e) { return skipped('compute_failed', e.message); }

  const v = await voidLotSnapshot(sb, {
    lotId: parentId,
    reason: `Repartido por división (ratio ${ratio})`,
    actor,
  });
  if (!v.ok) return v;

  const write = (lotId, part, label) => sb
    .from('lot_cost_snapshots')
    .insert({
      production_lot_id: lotId,
      costing_parameters_id: snap.costing_parameters_id,
      t1_per_kg_net: snap.t1_per_kg_net,
      t2_per_kg_own_net: snap.t2_per_kg_own_net,
      snapshot_date: snap.snapshot_date,
      kg_input_net_total: part.kg_input_net_total,
      kg_input_net_own: part.kg_input_net_own,
      kg_input_net_purchased: part.kg_input_net_purchased,
      kg_dried_output: part.kg_dried_output,
      real_factor_dried_per_input: part.real_factor_dried_per_input,
      purchase_cost_cop: part.purchase_cost_cop,
      t2_cost_cop: part.t2_cost_cop,
      t1_cost_cop: part.t1_cost_cop,
      source_kind: 'split_from',
      source_snapshot_id: snap.id,
      notes: `${label} de la división (ratio ${ratio}). Costo por kg idéntico al original.`,
      created_by: actor,
    })
    .select('*').single();

  const { data: childSnap, error: cErr } = await write(childId, parts.child, 'Hijo');
  if (cErr) return skipped('insert_failed', cErr.message);
  const { data: parentSnap, error: pErr } = await write(parentId, parts.parentRemainder, 'Remanente del padre');
  if (pErr) return skipped('insert_failed', pErr.message);

  return done(childSnap, { parent_snapshot: parentSnap, split: true });
}

module.exports = { snapshotLotAtDryExit, voidLotSnapshot, splitLotSnapshot };
