'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { computeGreenAvailability } = require('./_lib/lotAvailability');
const { created, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /lot-purchases-create  (finca, admin)
 *
 * Registra una compra en finca de un lote en bodega.
 * Body:
 *   production_lot_id   uuid
 *   client_name         string (requerido)
 *   kg_green_allocated  number > 0  (verde)
 *   notes?              string
 *
 * Valida que kg_green_allocated no exceda el verde disponible neto del
 * lote (descontando pedidos, compras previas, despachos y mezclas).
 */
exports.handler = requireAuth(['finca', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const production_lot_id = body.production_lot_id;
  const client_name = (body.client_name || '').toString().trim();
  const kg = Number(body.kg_green_allocated);
  const notes = body.notes == null ? null : String(body.notes);

  if (!production_lot_id) return badReq('production_lot_id required', 'LOT_ID_REQUIRED');
  if (!client_name) return badReq('client_name requerido', 'CLIENT_REQUIRED');
  if (!Number.isFinite(kg) || kg <= 0) return badReq('kg_green_allocated must be > 0', 'INVALID_KG');

  const sb = getSupabase();
  const { data: lot, error: lErr } = await sb
    .from('production_lots').select('id, bache_code, lot_code').eq('id', production_lot_id).maybeSingle();
  if (lErr) return serverErr('Lookup failed', lErr.message);
  if (!lot) return notFound('Lot not found');

  let avail;
  try { avail = await computeGreenAvailability(sb, production_lot_id); }
  catch (e) { return serverErr('Availability calc failed', e.message); }

  if (kg > avail.available + 0.01) {
    return conflict(
      `Lote ${lot.bache_code || lot.lot_code}: solicitado ${kg} kg verde, disponible ${avail.available} kg`,
      'EXCEEDS_AVAILABLE');
  }

  const { data, error } = await sb
    .from('lot_purchases').insert({
      production_lot_id, client_name, kg_green_allocated: kg, notes,
      created_by: session.role,
    }).select().single();
  if (error) return serverErr('Insert failed', error.message);

  return created({ purchase: data, availability: avail });
});
