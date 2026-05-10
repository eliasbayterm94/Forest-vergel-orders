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
 *     Natural: { drying_days: 12, processing_days: 6, dried_to_green_divisor: 3.40 },
 *     Honey:   { drying_days:  8, processing_days: 6, dried_to_green_divisor: 1.50 },
 *     Lavado:  { drying_days:  8, processing_days: 6, dried_to_green_divisor: 1.34 },
 *   }
 *
 * processing_days defaultea a 6 si la migracion 0016 no esta aplicada.
 */
let _processConfigCache = null;
async function getProcessConfig() {
  if (_processConfigCache) return _processConfigCache;
  const sb = getSupabase();
  const { data, error } = await sb
    .from('process_lead_times')
    .select('process_type, drying_days, dried_to_green_divisor, processing_days');
  if (error) {
    // Si la columna no existe (pre-migracion 0016), reintenta sin ella.
    if (/processing_days/.test(error.message)) {
      const { data: data2, error: err2 } = await sb
        .from('process_lead_times')
        .select('process_type, drying_days, dried_to_green_divisor');
      if (err2) throw new Error(`Failed to load process_lead_times: ${err2.message}`);
      const map = {};
      for (const row of data2) {
        map[row.process_type] = {
          drying_days:            Number(row.drying_days),
          processing_days:        6,
          dried_to_green_divisor: Number(row.dried_to_green_divisor),
        };
      }
      _processConfigCache = map;
      return map;
    }
    throw new Error(`Failed to load process_lead_times: ${error.message}`);
  }
  const map = {};
  for (const row of data) {
    map[row.process_type] = {
      drying_days:            Number(row.drying_days),
      processing_days:        row.processing_days != null ? Number(row.processing_days) : 6,
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

/** Returns { Natural: 6, Honey: 6, Lavado: 6 } (default fallback 6). */
async function getProcessingDaysByProcess() {
  const cfg = await getProcessConfig();
  const out = {};
  for (const [k, v] of Object.entries(cfg)) out[k] = v.processing_days != null ? v.processing_days : 6;
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

// ── production_config singleton ─────────────────────────────────
let _productionConfigCache = null;
async function getProductionConfig() {
  if (_productionConfigCache) return _productionConfigCache;
  const sb = getSupabase();
  const { data, error } = await sb
    .from('production_config')
    .select('weekly_cherry_capacity_kg, updated_at, updated_by')
    .eq('id', 1).maybeSingle();
  // Si la migracion 0018 no esta aplicada o la fila no existe, fallback
  // al default historico de 60000 (mismo valor que estaba hardcoded).
  if (error || !data) {
    _productionConfigCache = { weekly_cherry_capacity_kg: 60000 };
    return _productionConfigCache;
  }
  _productionConfigCache = data;
  return _productionConfigCache;
}
function clearProductionConfigCache() { _productionConfigCache = null; }

module.exports = {
  getSupabase,
  getProcessConfig,
  getDryingDaysByProcess,
  getProcessingDaysByProcess,
  getDriedDivisorsByProcess,
  clearLeadCache,
  getProductionConfig,
  clearProductionConfigCache,
};
