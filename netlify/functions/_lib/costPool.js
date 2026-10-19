'use strict';

/**
 * Cost pools — perpetual weighted average for raw material nobody can
 * trace lot by lot.
 *
 * THE PROBLEM
 * Several suppliers deliver the same grade on the same day; it all
 * goes into the same tanks. Nobody knows whose cherry ended up in
 * which batch, and for the plant it is one quality of raw material.
 *
 * THE ANSWER
 * A pool holds (kg on hand, COP on hand). Each reception adds its NET
 * kg and the amount actually paid; each draw takes kg out at the
 * average in force at that moment and reduces both sides. If the pool
 * is fully consumed, the total charged to lots equals the total paid
 * exactly — no over- or under-absorption from the pool itself.
 *
 * WHY PERPETUAL AND NOT PER DAY
 * Cherry left over from yesterday is physically indistinguishable from
 * today's. A daily pool forces an artificial cut and strands the
 * leftover. A perpetual average gives the same answer when everything
 * is consumed same-day and a better one when it is not. And a
 * reception entered late only moves the average FORWARD — it never
 * re-costs a draw that already happened, which is what keeps frozen
 * costs frozen.
 *
 * NEGATIVE BALANCE
 * Ops decided: let it through with an alert. Blocking a batch because
 * the invoice has not been keyed in yet is how people stop using the
 * system. A draw against an empty pool is charged at the last known
 * average, the balance goes negative, and the report says so.
 *
 * This module is PURE: it replays events it is handed. Nothing here
 * reads the database.
 */

const round4 = (n) => Math.round(Number(n) * 10000) / 10000;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Replay a pool's history in chronological order.
 *
 *   receptions [{ id, received_date, kg_net, amount_paid_cop }]
 *   draws      [{ id, drawn_at, kg }]
 *
 * Receptions are dated (a date), draws are timestamped. A reception is
 * treated as happening at the start of its day, so material keyed in
 * the morning is available to that day's draws.
 *
 * Returns the current state plus the full timeline, so the UI can show
 * exactly how an average came to be.
 */
function computePoolState({ receptions = [], draws = [] } = {}) {
  const events = [];

  for (const r of receptions) {
    const kg = Number(r.kg_net);
    const cop = Number(r.amount_paid_cop);
    if (!Number.isFinite(kg) || kg <= 0) continue;        // nothing usable left after by-product
    events.push({
      at: `${String(r.received_date).slice(0, 10)}T00:00:00.000Z`,
      kind: 'reception',
      id: r.id,
      kg,
      cop: Number.isFinite(cop) ? cop : 0,
    });
  }

  for (const d of draws) {
    const kg = Number(d.kg);
    if (!Number.isFinite(kg) || kg <= 0) continue;
    events.push({
      at: new Date(d.drawn_at).toISOString(),
      kind: 'draw',
      id: d.id,
      kg,
    });
  }

  // Same instant: receptions first, so a draw on the day material
  // arrived sees it.
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1
    : (a.kind === 'reception' ? -1 : a.kind === b.kind ? 0 : 1)));

  let kgOnHand = 0;
  let copOnHand = 0;
  let lastKnownAvg = 0;
  let totalReceivedKg = 0, totalReceivedCop = 0, totalDrawnKg = 0, totalDrawnCop = 0;
  let wentNegative = false;
  const timeline = [];

  for (const e of events) {
    if (e.kind === 'reception') {
      kgOnHand += e.kg;
      copOnHand += e.cop;
      totalReceivedKg += e.kg;
      totalReceivedCop += e.cop;
      if (kgOnHand > 0) lastKnownAvg = copOnHand / kgOnHand;
      timeline.push({
        at: e.at, kind: 'reception', id: e.id,
        kg: round2(e.kg), cop: round2(e.cop),
        kg_on_hand: round2(kgOnHand), cop_on_hand: round2(copOnHand),
        avg_after: kgOnHand > 0 ? round4(copOnHand / kgOnHand) : null,
      });
    } else {
      // Charge at the average in force right now. With an empty pool
      // (invoice not keyed in yet) fall back to the last average we
      // knew, and flag it — the draw is not blocked.
      const avg = kgOnHand > 0 ? copOnHand / kgOnHand : lastKnownAvg;
      const cop = e.kg * avg;
      kgOnHand -= e.kg;
      copOnHand -= cop;
      totalDrawnKg += e.kg;
      totalDrawnCop += cop;
      if (kgOnHand < -1e-6) wentNegative = true;
      timeline.push({
        at: e.at, kind: 'draw', id: e.id,
        kg: round2(e.kg), cop: round2(cop), cost_per_kg: round4(avg),
        kg_on_hand: round2(kgOnHand), cop_on_hand: round2(copOnHand),
        short: kgOnHand < -1e-6,
      });
    }
  }

  const onHand = round2(kgOnHand);
  return {
    kg_on_hand: onHand,
    cop_on_hand: round2(copOnHand),
    // The rate the NEXT draw would be charged at.
    avg_cost_per_kg: kgOnHand > 1e-6 ? round4(copOnHand / kgOnHand) : round4(lastKnownAvg),
    // True when the pool has no balance to draw from: the next draw
    // uses the last known average and the report flags it.
    is_short: onHand <= 0,
    went_negative: wentNegative,

    total_received_kg:  round2(totalReceivedKg),
    total_received_cop: round2(totalReceivedCop),
    total_drawn_kg:     round2(totalDrawnKg),
    total_drawn_cop:    round2(totalDrawnCop),
    // Lifetime average of everything received. Useful as a sanity
    // check against avg_cost_per_kg.
    lifetime_avg_cost_per_kg: totalReceivedKg > 0
      ? round4(totalReceivedCop / totalReceivedKg) : null,

    timeline,
  };
}

/**
 * What one draw of `kg` would cost right now, without mutating state.
 * Used when a lot draws material, to freeze the price on the source row.
 */
function quoteDraw(state, kg) {
  const n = Number(kg);
  if (!Number.isFinite(n) || n <= 0) throw new Error('kg must be > 0');
  const perKg = Number(state.avg_cost_per_kg) || 0;
  return {
    kg: round2(n),
    cost_per_kg: round4(perKg),
    cost_cop: round2(n * perKg),
    // The caller surfaces this: the pool cannot back the draw, usually
    // because a reception has not been keyed in yet.
    short: !!state.is_short || n > Number(state.kg_on_hand || 0) + 1e-6,
  };
}

/**
 * What was paid for a reception.
 *
 * cherry_receptions.amount_paid_cop is a generated column, so normally
 * it just comes back from the database. This derives it when it does
 * not, because the failure mode matters: a missing amount would cost
 * the coffee at ZERO and make it look free. NULL is only legitimate
 * when there is no price at all — own production, costed with T2.
 */
function receptionAmountPaid(reception) {
  const stored = reception.amount_paid_cop;
  if (stored != null && Number.isFinite(Number(stored))) return round2(stored);

  const price = reception.price_per_kg;
  if (price == null) return null;            // own production: no price by design

  const gross = Number(reception.kg_gross) || 0;
  const discount = Number(reception.discount_pct) || 0;
  return round2(gross * Number(price) * (1 - discount));
}

/**
 * Net kg of a reception: gross minus whatever was separated as
 * by-product. Single source of truth is lot_byproducts, so net is
 * always derived and the two numbers cannot drift apart.
 */
function receptionNetKg(reception, byproducts = []) {
  const gross = Number(reception.kg_gross) || 0;
  const sep = byproducts.reduce((s, b) => s + (Number(b.kg) || 0), 0);
  return round2(Math.max(0, gross - sep));
}

/**
 * Floater rate and the discount that would have offset it.
 *
 * The break-even discount equals the floater rate exactly: discount the
 * same percentage that floated and the cost per net kg is unchanged.
 * That makes "% floaters vs. % discount" a negotiating number, not
 * trivia — a supplier at a lower price with heavy floaters can be the
 * expensive one.
 */
function byproductRate(reception, byproducts = []) {
  const gross = Number(reception.kg_gross) || 0;
  if (gross <= 0) return null;
  const sep = byproducts.reduce((s, b) => s + (Number(b.kg) || 0), 0);
  const rate = sep / gross;
  const discount = Number(reception.discount_pct) || 0;
  return {
    kg_gross: round2(gross),
    kg_byproduct: round2(sep),
    kg_net: round2(gross - sep),
    byproduct_pct: round4(rate),
    discount_pct: round4(discount),
    // Positive = the discount fell short of the floaters by this much.
    shortfall_pct: round4(rate - discount),
    // Any estimated weight in the mix: report it so an estimate is
    // never read as a measured fact.
    has_estimates: byproducts.some((b) => b.measurement === 'estimated'),
  };
}

module.exports = {
  computePoolState, quoteDraw, receptionNetKg, byproductRate, receptionAmountPaid,
  round2, round4,
};
