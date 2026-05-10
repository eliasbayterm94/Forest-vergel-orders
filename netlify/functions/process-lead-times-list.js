'use strict';

const { requireAuth } = require('./_lib/auth');
const { getProcessConfig } = require('./_lib/supabase');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /process-lead-times-list
 * Returns the per-process drying_days + dried_to_green_divisor map.
 * Used by client views (monitoring, etc.) to flag drying overrun.
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  try {
    const cfg = await getProcessConfig();
    const list = Object.entries(cfg).map(([process_type, v]) => ({
      process_type,
      drying_days: v.drying_days,
      dried_to_green_divisor: v.dried_to_green_divisor,
    }));
    return ok({ process_lead_times: list });
  } catch (e) {
    return serverErr('Failed to load process lead times', e.message);
  }
});
