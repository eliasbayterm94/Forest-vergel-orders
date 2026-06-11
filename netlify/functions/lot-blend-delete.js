'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /lot-blend-delete  (finca, admin)
 * Body: { blend_lot_id }
 *
 * Borra una mezcla (lote con is_blend=true). El CASCADE en
 * lot_blend_components.blend_lot_id limpia los componentes,
 * lo que libera el kg seco de los baches padre.
 *
 * Si la mezcla ya fue usada en otra mezcla (es source de otro
 * blend), o tiene shipments/asignaciones, la FK bloquea el
 * delete y devolvemos un error legible.
 */
exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const blend_lot_id = body.blend_lot_id;
  if (!blend_lot_id) return badReq('blend_lot_id required', 'BLEND_LOT_ID_REQUIRED');

  const sb = getSupabase();
  const { data: lot, error: lErr } = await sb
    .from('production_lots').select('id, is_blend, blend_code, bache_code').eq('id', blend_lot_id).maybeSingle();
  if (lErr) return serverErr('Lookup failed', lErr.message);
  if (!lot) return notFound('Mezcla no encontrada');
  if (!lot.is_blend) return badReq('El lote no es una mezcla', 'NOT_A_BLEND');

  // Verificar que esta mezcla no haya sido usada en otra mezcla
  const { data: usedIn } = await sb
    .from('lot_blend_components')
    .select('blend_lot_id')
    .eq('source_lot_id', blend_lot_id)
    .limit(1);
  if (usedIn && usedIn.length > 0) {
    return conflict('Esta mezcla fue usada en otra mezcla y no se puede eliminar', 'IN_USE_BY_OTHER_BLEND');
  }

  // Verificar despachos
  const { data: ship } = await sb
    .from('shipment_lots').select('id').eq('production_lot_id', blend_lot_id).limit(1);
  if (ship && ship.length > 0) {
    return conflict('Esta mezcla ya está en un despacho y no se puede eliminar', 'IN_USE_BY_SHIPMENT');
  }

  // Eliminar (CASCADE limpia lot_blend_components, lot_order_assignments, varieties, purchases)
  const { error: delErr } = await sb.from('production_lots').delete().eq('id', blend_lot_id);
  if (delErr) return serverErr('Delete failed', delErr.message);

  return ok({ deleted: lot.blend_code || lot.bache_code || blend_lot_id });
});
