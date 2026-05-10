'use strict';

const { requireAuth } = require('./_lib/auth');
const { getProductionConfig } = require('./_lib/supabase');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /production-config-get
 * Devuelve la configuracion global de la planta (singleton).
 * Cualquier rol autenticado puede leerlo (lo necesita el dashboard /
 * la cola para mostrar la capacidad).
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  try {
    const cfg = await getProductionConfig();
    return ok({ config: cfg });
  } catch (e) {
    return serverErr('Failed to load production config', e.message);
  }
});
