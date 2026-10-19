'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { listPoolKeys, getPoolState } = require('./_lib/costingData');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /cost-pools-list  (finca, admin, forest)
 *   ?pool_key=regional        one pool, with its full timeline
 *   ?with_timeline=true       include timelines for every pool
 *
 * Balance of each weighted-average pool: kg received, kg drawn, kg on
 * hand and the rate the next draw would pay.
 *
 * is_short / went_negative are the operational alert: a pool with no
 * balance usually means a reception has not been keyed in yet. Lots are
 * never blocked for it — the gap shows up here instead.
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const q = event.queryStringParameters || {};
  const sb = getSupabase();

  try {
    if (q.pool_key) {
      const state = await getPoolState(sb, q.pool_key);
      return ok({ pools: [state] });
    }

    const keys = await listPoolKeys(sb);
    const pools = [];
    for (const key of keys) {
      const state = await getPoolState(sb, key);
      if (q.with_timeline !== 'true') delete state.timeline;
      pools.push(state);
    }
    return ok({ pools });
  } catch (e) {
    return serverErr('Failed to load cost pools', e.message);
  }
});
