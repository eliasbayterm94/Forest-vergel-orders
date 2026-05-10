'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase, clearProductionConfigCache } = require('./_lib/supabase');
const { ok, badReq, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /production-config-update  (admin)
 * Body: { weekly_cherry_capacity_kg }
 *
 * Actualiza la fila singleton (id = 1) y bustea el cache local del
 * lambda. Otros lambdas levantados verán el cambio al ser called
 * (cold start o cuando el cache expire).
 */
exports.handler = requireAuth(['admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const cap = Number(body.weekly_cherry_capacity_kg);
  if (!Number.isFinite(cap) || cap <= 0) {
    return badReq('weekly_cherry_capacity_kg must be > 0', 'INVALID_CAPACITY');
  }
  if (cap > 10_000_000) {
    return badReq('weekly_cherry_capacity_kg suspiciously high (>10M)', 'CAPACITY_TOO_HIGH');
  }

  const sb = getSupabase();
  // Upsert sobre singleton: si no existe, insertarla; si existe, actualizar.
  const { data, error } = await sb
    .from('production_config')
    .upsert({
      id: 1,
      weekly_cherry_capacity_kg: Math.round(cap),
      updated_at: new Date().toISOString(),
      updated_by: session.role,
    }, { onConflict: 'id' })
    .select()
    .single();
  if (error) return serverErr('Failed to update production config', error.message);

  clearProductionConfigCache();
  return ok({ config: data });
});
