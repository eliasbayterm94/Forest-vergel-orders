'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /production-lots-delete  (finca, admin)
 * Body: { lot_id }
 *
 * Borra un bache completo. Las tablas dependientes con FK
 * ON DELETE CASCADE (lot_varieties, lot_order_assignments, lot_partials)
 * se limpian automáticamente. shipment_lots tiene ON DELETE RESTRICT,
 * así que si el bache ya fue despachado retornamos 409.
 *
 * El conteo de asignaciones removidas se devuelve para que el cliente
 * pueda mostrarlo en el mensaje de éxito.
 */
exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const lot_id = body.lot_id;
  if (!lot_id) return badReq('lot_id required', 'LOT_ID_REQUIRED');

  const sb = getSupabase();

  // Bloqueo explícito si el bache ya está embarcado (mejor que esperar el
  // error 23503 de Postgres, que sería más opaco para el cliente).
  const { data: shipped, error: shipErr } = await sb
    .from('shipment_lots').select('shipment_id').eq('production_lot_id', lot_id).limit(1);
  if (shipErr) return serverErr('Could not check shipments', shipErr.message);
  if (shipped && shipped.length > 0) {
    return conflict('No se puede eliminar: el bache ya fue despachado.', 'LOT_SHIPPED');
  }

  // Conteo de asignaciones antes del delete, para informar al usuario.
  const { count: assignmentCount } = await sb
    .from('lot_order_assignments').select('*', { count: 'exact', head: true })
    .eq('production_lot_id', lot_id);

  const { data: deleted, error } = await sb
    .from('production_lots').delete().eq('id', lot_id).select().maybeSingle();

  if (error) {
    // 23503 = foreign_key_violation. Catch-all por si aparece otro
    // dependiente en el futuro.
    if (error.code === '23503') {
      return conflict('No se puede eliminar: el bache tiene dependencias bloqueantes.', 'LOT_HAS_DEPENDENCIES');
    }
    return serverErr('Delete failed', error.message);
  }
  if (!deleted) return notFound('Bache no encontrado');

  return ok({ deleted, assignments_removed: assignmentCount || 0 });
});
