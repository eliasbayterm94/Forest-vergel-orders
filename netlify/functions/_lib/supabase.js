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
 * Load drying-day lookup once per cold start.
 * Returns { Natural: 12, Honey: 8, Lavado: 8 }.
 */
let _leadCache = null;
async function getDryingDaysByProcess() {
  if (_leadCache) return _leadCache;
  const sb = getSupabase();
  const { data, error } = await sb.from('process_lead_times').select('process_type, drying_days');
  if (error) throw new Error(`Failed to load process_lead_times: ${error.message}`);
  const map = {};
  for (const row of data) map[row.process_type] = Number(row.drying_days);
  _leadCache = map;
  return map;
}

function clearLeadCache() { _leadCache = null; }

module.exports = { getSupabase, getDryingDaysByProcess, clearLeadCache };
