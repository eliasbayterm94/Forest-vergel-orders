/**
 * Server-side Supabase client. Uses service_role key — bypasses RLS.
 * NEVER import this module into client-side code.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

let _client = null;

function getSupabase() {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Supabase env vars missing: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db:   { schema: 'public' },
  });
  return _client;
}

/**
 * Load process_lead_times once per cold start.
 * Returns:
 *   {
 *     Natural: { drying_days: 12, dried_to_green_divisor: 3.40 },
 *     Honey:   { drying_days:  8, dried_to_green_divisor: 1.50 },
 *     Lavado:  { drying_days:  8, dried_to_green_divisor: 1.34 },
 *   }
 */
let _processConfigCache = null;
async function getProcessConfig() {
  if (_processConfigCache) return _processConfigCache;
  const sb = getSupabase();
  const { data, error } = await sb
    .from('process_lead_times')
    .select('process_type, drying_days, dried_to_green_divisor');
  if (error) throw new Error(`Failed to load process_lead_times: ${error.message}`);
  const map = {};
  for (const row of data) {
    map[row.process_type] = {
      drying_days:            Number(row.drying_days),
      dried_to_green_divisor: Number(row.dried_to_green_divisor),
    };
  }
  _processConfigCache = map;
  return map;
}

/** Returns { Natural: 12, Honey: 8, Lavado: 8 }. */
async function getDryingDaysByProcess() {
  const cfg = await getProcessConfig();
  const out = {};
  for (const [k, v] of Object.entries(cfg)) out[k] = v.drying_days;
  return out;
}

/** Returns { Natural: 3.40, Honey: 1.50, Lavado: 1.34 }. */
async function getDriedDivisorsByProcess() {
  const cfg = await getProcessConfig();
  const out = {};
  for (const [k, v] of Object.entries(cfg)) out[k] = v.dried_to_green_divisor;
  return out;
}

function clearLeadCache() { _processConfigCache = null; }

module.exports = {
  getSupabase,
  getProcessConfig,
  getDryingDaysByProcess,
  getDriedDivisorsByProcess,
  clearLeadCache,
};
