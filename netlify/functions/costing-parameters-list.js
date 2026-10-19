'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { isMissingTable } = require('./_lib/costingData');
const { bogotaToday } = require('./_lib/bogotaTime');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /costing-parameters-list  (admin, forest)
 *
 * Every tariff version, newest first, plus which one is in force today
 * so the UI does not have to work it out.
 */
exports.handler = requireAuth(['admin', 'forest'], async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);

  const sb = getSupabase();
  const { data, error } = await sb
    .from('costing_parameters').select('*')
    .order('effective_from', { ascending: false });
  if (error) {
    if (isMissingTable(error)) {
      return ok({ costing_parameters: [], in_force: null, today: bogotaToday(), table_missing: true });
    }
    return serverErr('Failed to load costing parameters', error.message);
  }

  const today = bogotaToday();
  const rows = data || [];
  const inForce = rows.find((r) => String(r.effective_from).slice(0, 10) <= today) || null;

  return ok({ costing_parameters: rows, in_force: inForce, today, table_missing: false });
});
