'use strict';

/**
 * Lot costing — the pure calculation. No database, no clock, no I/O:
 * it takes the lot's input sources plus the tariffs in force and
 * returns the cost breakdown. See migrations 0051 and 0052.
 *
 * THE POLICY, IN FOUR LINES
 *
 *   cost per kg of NET input = purchase price   (third party, identified or pooled)
 *                            | T2               (own production)
 *                            | 0                (by-product / floaters)
 *                            + T1               (always, FLAT, whatever the entry stage)
 *
 *   total cost       = Σ kg × (entry cost + T1)
 *   cost per kg dry  = total cost ÷ kg dried out
 *
 * WHY T1 IS FLAT
 * A kg entering already dry yields ~5.7x more finished coffee than a kg
 * of cherry, so a flat charge self-dilutes per kg of finished product
 * and lands within ~27% of a stage-weighted scheme. More importantly, a
 * flat charge makes the monthly close independent of the entry-stage
 * mix — only total volume moves it. The budget denominator must be
 * stated the same way: net kg entering, any stage.
 *
 * WHAT THIS MODULE DOES NOT DO
 *   · It does not decide WHEN to cost (that is the dry exit).
 *   · It does not read tariffs (the caller resolves the version in
 *     force on the exit date and passes the rates in).
 *   · It does not re-cost blends or splits: those INHERIT, and have
 *     their own functions below so T1 is never applied twice.
 */

const COST_BASIS = Object.freeze({
  purchaseIdentified: 'purchase_identified',
  purchasePool:       'purchase_pool',
  own:                'own',
  byproduct:          'byproduct',
});

const ENTRY_STAGES = Object.freeze(['cereza', 'despulpado', 'seco']);

/** COP rounds to the peso; kg to 2 decimals; rates keep 4. */
const roundCop = (n) => Math.round(Number(n) * 100) / 100;
const roundKg  = (n) => Math.round(Number(n) * 100) / 100;
const round4   = (n) => Math.round(Number(n) * 10000) / 10000;
const round6   = (n) => Math.round(Number(n) * 1000000) / 1000000;

/**
 * Entry cost per kg for one source, before T1.
 * Throws on a shape the database would have rejected, so a bad row
 * cannot quietly cost at zero.
 */
function entryCostPerKg(source, params) {
  switch (source.cost_basis) {
    case COST_BASIS.purchaseIdentified:
    case COST_BASIS.purchasePool: {
      const p = Number(source.purchase_cost_per_kg);
      if (!Number.isFinite(p) || p < 0) {
        throw new Error(`Source ${source.cost_basis} needs a purchase_cost_per_kg >= 0`);
      }
      return p;
    }
    case COST_BASIS.own: {
      const t2 = Number(params.t2_per_kg_own_net);
      if (!Number.isFinite(t2) || t2 < 0) throw new Error('t2_per_kg_own_net must be >= 0');
      return t2;
    }
    case COST_BASIS.byproduct:
      // Zero by policy: the usable coffee already absorbed the whole
      // amount paid, and the floaters' processing sits inside T1
      // because the budget denominator excludes them.
      return 0;
    default:
      throw new Error(`Unknown cost_basis "${source.cost_basis}"`);
  }
}

/**
 * Cost one dry exit.
 *
 *   sources         [{ kg, entry_stage, cost_basis, purchase_cost_per_kg? }]
 *   kgDriedOutput   kg of dried product that came out
 *   params          { t1_per_kg_net, t2_per_kg_own_net }
 *
 * Returns the breakdown ready to persist as a snapshot. Every COP
 * figure is rounded to the peso; the caller stores the parts and the
 * database derives the total, so the two can never disagree.
 */
function computeLotCost({ sources, kgDriedOutput, params }) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('A lot needs at least one input source to be costed');
  }
  const t1 = Number(params && params.t1_per_kg_net);
  if (!Number.isFinite(t1) || t1 < 0) throw new Error('t1_per_kg_net must be >= 0');

  const dried = Number(kgDriedOutput);
  if (!Number.isFinite(dried) || dried < 0) throw new Error('kgDriedOutput must be >= 0');

  let kgTotal = 0, kgOwn = 0, kgPurchased = 0, kgByproduct = 0;
  let purchaseCop = 0, t2Cop = 0, t1Cop = 0;
  const lines = [];

  for (const s of sources) {
    const kg = Number(s.kg);
    if (!Number.isFinite(kg) || kg <= 0) throw new Error('Every source needs kg > 0');
    if (!ENTRY_STAGES.includes(s.entry_stage)) {
      throw new Error(`Unknown entry_stage "${s.entry_stage}"`);
    }

    const entryPerKg = entryCostPerKg(s, params);
    const entryCop   = roundCop(kg * entryPerKg);
    // T1 is flat: the same rate for every stage, charged on net kg.
    // By-product pays none — charging it would double-count, since the
    // good coffee's T1 already covers processing the floaters.
    const paysT1     = s.cost_basis !== COST_BASIS.byproduct;
    const lineT1Cop  = paysT1 ? roundCop(kg * t1) : 0;

    kgTotal += kg;
    if (s.cost_basis === COST_BASIS.own) {
      kgOwn += kg;
      t2Cop += entryCop;
    } else if (s.cost_basis === COST_BASIS.byproduct) {
      kgByproduct += kg;
    } else {
      kgPurchased += kg;
      purchaseCop += entryCop;
    }
    t1Cop += lineT1Cop;

    lines.push({
      cost_basis:         s.cost_basis,
      entry_stage:        s.entry_stage,
      kg:                 roundKg(kg),
      entry_cost_per_kg:  round4(entryPerKg),
      t1_per_kg:          paysT1 ? round4(t1) : 0,
      cost_per_kg:        round4(entryPerKg + (paysT1 ? t1 : 0)),
      entry_cost_cop:     entryCop,
      t1_cost_cop:        lineT1Cop,
      total_cost_cop:     roundCop(entryCop + lineT1Cop),
    });
  }

  const totalCop = roundCop(purchaseCop + t2Cop + t1Cop);

  return {
    kg_input_net_total:     roundKg(kgTotal),
    kg_input_net_own:       roundKg(kgOwn),
    kg_input_net_purchased: roundKg(kgPurchased),
    kg_input_net_byproduct: roundKg(kgByproduct),
    kg_dried_output:        roundKg(dried),

    // kg dried per kg of net input. NOT the Colombian factor_rendimiento
    // (kg parchment per 70-kg sack) and the exact reciprocal of
    // production_lots.conversion_factor — hence the long name.
    real_factor_dried_per_input: kgTotal > 0 ? round6(dried / kgTotal) : null,

    purchase_cost_cop: roundCop(purchaseCop),
    t2_cost_cop:       roundCop(t2Cop),
    t1_cost_cop:       roundCop(t1Cop),
    total_cost_cop:    totalCop,
    cost_per_kg_dried: dried > 0 ? round4(totalCop / dried) : null,

    t1_per_kg_net:     round4(t1),
    t2_per_kg_own_net: round4(Number(params.t2_per_kg_own_net) || 0),

    lines,
  };
}

/**
 * Cost of a BLEND: the weighted average of its components' cost per kg
 * of dried product, weighted by the kg each contributed.
 *
 *   components [{ kg_dried_used, cost_per_kg_dried }]
 *
 * T1 is deliberately NOT applied here. The cherry already paid for
 * processing when each component was costed; charging it again would
 * double-count and inflate the month's absorbed figure.
 */
function computeBlendCost({ components, kgDriedOutput }) {
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error('A blend needs at least one component');
  }

  let kgUsed = 0, totalCop = 0;
  const lines = [];

  for (const c of components) {
    const kg = Number(c.kg_dried_used);
    if (!Number.isFinite(kg) || kg <= 0) throw new Error('Every component needs kg_dried_used > 0');
    const perKg = Number(c.cost_per_kg_dried);
    if (!Number.isFinite(perKg) || perKg < 0) {
      throw new Error('Every component needs a cost_per_kg_dried >= 0 (cost the parent first)');
    }
    const cop = roundCop(kg * perKg);
    kgUsed += kg;
    totalCop += cop;
    lines.push({ kg_dried_used: roundKg(kg), cost_per_kg_dried: round4(perKg), cost_cop: cop });
  }

  // Default the output to what went in: a blend neither gains nor
  // loses weight by being mixed.
  const dried = kgDriedOutput == null ? kgUsed : Number(kgDriedOutput);
  if (!Number.isFinite(dried) || dried <= 0) throw new Error('kgDriedOutput must be > 0');

  totalCop = roundCop(totalCop);

  return {
    kg_dried_used:     roundKg(kgUsed),
    kg_dried_output:   roundKg(dried),
    total_cost_cop:    totalCop,
    cost_per_kg_dried: round4(totalCop / dried),
    lines,
  };
}

/**
 * Share a frozen snapshot out to a split child.
 *
 * A split moves mass, it does not re-process coffee: the child's cost
 * per kg is IDENTICAL to the parent's and only the totals scale. Ratio
 * comes from the mass actually moved.
 */
function splitSnapshotCost({ snapshot, ratio }) {
  const r = Number(ratio);
  if (!Number.isFinite(r) || r <= 0 || r >= 1) {
    throw new Error('ratio must be between 0 and 1 (exclusive)');
  }
  const scale = (v) => roundCop(Number(v || 0) * r);
  const keep  = (v) => roundCop(Number(v || 0) * (1 - r));

  const child = {
    kg_input_net_total:     roundKg(Number(snapshot.kg_input_net_total || 0) * r),
    kg_input_net_own:       roundKg(Number(snapshot.kg_input_net_own || 0) * r),
    kg_input_net_purchased: roundKg(Number(snapshot.kg_input_net_purchased || 0) * r),
    kg_dried_output:        roundKg(Number(snapshot.kg_dried_output || 0) * r),
    purchase_cost_cop:      scale(snapshot.purchase_cost_cop),
    t2_cost_cop:            scale(snapshot.t2_cost_cop),
    t1_cost_cop:            scale(snapshot.t1_cost_cop),
    real_factor_dried_per_input: snapshot.real_factor_dried_per_input ?? null,
    t1_per_kg_net:          snapshot.t1_per_kg_net,
    t2_per_kg_own_net:      snapshot.t2_per_kg_own_net,
  };
  child.total_cost_cop = roundCop(
    child.purchase_cost_cop + child.t2_cost_cop + child.t1_cost_cop);
  child.cost_per_kg_dried = child.kg_dried_output > 0
    ? round4(child.total_cost_cop / child.kg_dried_output) : null;

  const parentRemainder = {
    kg_input_net_total:     roundKg(Number(snapshot.kg_input_net_total || 0) * (1 - r)),
    kg_input_net_own:       roundKg(Number(snapshot.kg_input_net_own || 0) * (1 - r)),
    kg_input_net_purchased: roundKg(Number(snapshot.kg_input_net_purchased || 0) * (1 - r)),
    kg_dried_output:        roundKg(Number(snapshot.kg_dried_output || 0) * (1 - r)),
    purchase_cost_cop:      keep(snapshot.purchase_cost_cop),
    t2_cost_cop:            keep(snapshot.t2_cost_cop),
    t1_cost_cop:            keep(snapshot.t1_cost_cop),
    real_factor_dried_per_input: snapshot.real_factor_dried_per_input ?? null,
    t1_per_kg_net:          snapshot.t1_per_kg_net,
    t2_per_kg_own_net:      snapshot.t2_per_kg_own_net,
  };
  parentRemainder.total_cost_cop = roundCop(
    parentRemainder.purchase_cost_cop + parentRemainder.t2_cost_cop + parentRemainder.t1_cost_cop);
  parentRemainder.cost_per_kg_dried = parentRemainder.kg_dried_output > 0
    ? round4(parentRemainder.total_cost_cop / parentRemainder.kg_dried_output) : null;

  return { child, parentRemainder };
}

module.exports = {
  COST_BASIS, ENTRY_STAGES,
  computeLotCost, computeBlendCost, splitSnapshotCost,
  entryCostPerKg,
  roundCop, roundKg, round4, round6,
};
