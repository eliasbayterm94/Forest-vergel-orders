'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');
const { patchDraft } = require('./_lib/shipmentDraft');

/**
 * POST /shipments-update  (finca, admin)
 * Body: { shipment_id, header?: {...}, lines?: [{id, ...logística}] }
 *
 * Edita un despacho en BORRADOR completando la logística/empaque que
 * faltaba (destino, conductor, códigos, sacos/lonas, empaque, color,
 * observaciones). NO cambia qué baches / cuántos kg — eso se define
 * al crear el borrador; si hay que cambiar la estructura, se descarta
 * y se crea de nuevo.
 *
 * Solo aplica a borradores: un despacho confirmado es inmutable.
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
  if (ship.status !== 'draft') {
    return conflict('Solo se puede editar un despacho en borrador', 'NOT_A_DRAFT');
  }

  const r = await patchDraft(sb, shipment_id, { header: body.header, lines: body.lines });
  if (!r.ok) {
    if (['UPDATE_FAILED', 'LINE_LOOKUP_FAILED', 'LINE_UPDATE_FAILED'].includes(r.code)) {
      return serverErr(r.message, r.message);
    }
    return badReq(r.message, r.code);
  }

  return ok({ updated: true, shipment_id });
});
