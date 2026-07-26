'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');
const { patchDraft } = require('./_lib/shipmentDraft');

/**
 * POST /shipments-update  (finca, admin)
 * Body: { shipment_id, header?: {...}, lines?: [{id, ...logística}] }
 *
 * Edita la LOGÍSTICA de un despacho: destino, conductor, códigos de
 * trilladora (PP's) / mezcla, sacos/lonas, empaque, color,
 * observaciones. Ninguno de esos campos toca el inventario.
 *
 * - En BORRADOR también se pueden ajustar los kg a despachar.
 * - En un despacho CONFIRMADO se permite completar/editar la
 *   logística (p.ej. agregar los PP's que llegan de la trilladora
 *   después) pero NO los kg — el inventario ya se movió.
 *
 * Lo que NO cambia: qué baches entran ni sus divisiones (para eso se
 * descarta el borrador y se crea de nuevo).
 */
exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const shipment_id = body.shipment_id;
  if (!shipment_id) return badReq('shipment_id required', 'SHIPMENT_ID_REQUIRED');

  const sb = getSupabase();
  const { data: ship, error: sErr } = await sb
    .from('shipments').select('id, status').eq('id', shipment_id).maybeSingle();
  if (sErr) return serverErr('Lookup failed', sErr.message);
  if (!ship) return notFound('Shipment not found');

  // En confirmados solo se edita logística (kg bloqueado).
  const allowKg = ship.status === 'draft';
  const r = await patchDraft(sb, shipment_id, { header: body.header, lines: body.lines }, { allowKg });
  if (!r.ok) {
    if (['UPDATE_FAILED', 'LINE_LOOKUP_FAILED', 'LINE_UPDATE_FAILED'].includes(r.code)) {
      return serverErr(r.message, r.message);
    }
    if (r.code === 'EXCEEDS_AVAILABLE') return conflict(r.message, r.code);
    return badReq(r.message, r.code);
  }

  return ok({ updated: true, shipment_id, status: ship.status });
});
