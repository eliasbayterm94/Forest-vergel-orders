'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { LOT_STATUS } = require('./_lib/schema');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /lot-undo-stage  (finca, admin)
 *
 * Anula la última transición de etapa del bache. Solo se permite
 * anular el evento más reciente (el "tope" del historial).
 *
 * Body:
 *   lot_id      uuid
 *   event_kind  'drying' | 'resting-in' | 'back-to-drying' |
 *               'ready-from-drying' | 'ready-from-resting'
 *   cycle_id?   uuid (requerido para los kinds de resting)
 *
 * Efectos por kind:
 *
 *  drying              → status='InFermentation', limpia
 *                        drying_start_date y drying_locations.
 *
 *  resting-in          → borra el ciclo, status='Drying',
 *                        limpia resting_start_date / resting_humidity.
 *
 *  back-to-drying      → reabre el ciclo (end_*=NULL), status='Resting'.
 *
 *  ready-from-drying   → status='Drying', limpia ready_date,
 *                        final_humidity, kg de cierre (preservando
 *                        kg_dried_output si la etapa inicial era 'seco').
 *
 *  ready-from-resting  → reabre el ciclo, status='Resting', limpia
 *                        ready_date, final_humidity, kg de cierre.
 */
const ALLOWED_KINDS = new Set([
  'drying', 'resting-in', 'back-to-drying',
  'ready-from-drying', 'ready-from-resting',
]);

exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const { lot_id, event_kind, cycle_id } = body || {};
  if (!lot_id) return badReq('lot_id required', 'LOT_ID_REQUIRED');
  if (!ALLOWED_KINDS.has(event_kind)) return badReq('event_kind inválido', 'INVALID_KIND');

  const sb = getSupabase();
  const { data: lot, error: loadErr } = await sb
    .from('production_lots').select('*').eq('id', lot_id).maybeSingle();
  if (loadErr) return serverErr('Lookup failed', loadErr.message);
  if (!lot) return notFound('Lot not found');

  // Validar precondiciones por kind: el lote debe estar en el estado
  // resultante del evento que se quiere anular.
  if (event_kind === 'drying' && lot.status !== LOT_STATUS.Drying) {
    return conflict('Solo se puede anular "→ Secado" si el bache está en Secado', 'INVALID_PRECONDITION');
  }
  if (event_kind === 'resting-in' && lot.status !== LOT_STATUS.Resting) {
    return conflict('Solo se puede anular "→ Descanso" si el bache está en Descanso', 'INVALID_PRECONDITION');
  }
  if (event_kind === 'back-to-drying' && lot.status !== LOT_STATUS.Drying) {
    return conflict('Solo se puede anular "← Volver a Secado" si el bache está en Secado', 'INVALID_PRECONDITION');
  }
  if ((event_kind === 'ready-from-drying' || event_kind === 'ready-from-resting') && lot.status !== LOT_STATUS.Ready) {
    return conflict('Solo se puede anular "→ Listo" si el bache está en Listo', 'INVALID_PRECONDITION');
  }

  if (event_kind === 'drying') {
    const { error } = await sb.from('production_lots').update({
      status: LOT_STATUS.InFermentation,
      drying_start_date: null,
      drying_locations: null,
    }).eq('id', lot_id);
    if (error) return serverErr('Undo failed', error.message);
    return ok({ undone: 'drying' });
  }

  if (event_kind === 'resting-in') {
    if (!cycle_id) return badReq('cycle_id requerido', 'CYCLE_ID_REQUIRED');
    const { error: delErr } = await sb.from('lot_resting_cycles').delete().eq('id', cycle_id);
    if (delErr) return serverErr('Cycle delete failed', delErr.message);
    const { error } = await sb.from('production_lots').update({
      status: LOT_STATUS.Drying,
      resting_start_date: null,
      resting_humidity: null,
    }).eq('id', lot_id);
    if (error) return serverErr('Undo failed', error.message);
    return ok({ undone: 'resting-in' });
  }

  if (event_kind === 'back-to-drying') {
    if (!cycle_id) return badReq('cycle_id requerido', 'CYCLE_ID_REQUIRED');
    const { error: cErr } = await sb.from('lot_resting_cycles').update({
      end_date: null, end_humidity: null, end_reason: null,
    }).eq('id', cycle_id);
    if (cErr) return serverErr('Cycle reopen failed', cErr.message);
    const { error } = await sb.from('production_lots').update({
      status: LOT_STATUS.Resting,
    }).eq('id', lot_id);
    if (error) return serverErr('Undo failed', error.message);
    return ok({ undone: 'back-to-drying' });
  }

  if (event_kind === 'ready-from-drying') {
    const preserveDried = lot.processing_stage === 'seco';
    const upd = {
      status: LOT_STATUS.Drying,
      ready_date: null,
      final_humidity: null,
      kg_green_actual: null,
      factor_rendimiento: null,
      conversion_factor: null,
    };
    if (!preserveDried) upd.kg_dried_output = null;
    const { error } = await sb.from('production_lots').update(upd).eq('id', lot_id);
    if (error) return serverErr('Undo failed', error.message);
    return ok({ undone: 'ready-from-drying' });
  }

  if (event_kind === 'ready-from-resting') {
    if (!cycle_id) return badReq('cycle_id requerido', 'CYCLE_ID_REQUIRED');
    const { error: cErr } = await sb.from('lot_resting_cycles').update({
      end_date: null, end_humidity: null, end_reason: null,
    }).eq('id', cycle_id);
    if (cErr) return serverErr('Cycle reopen failed', cErr.message);
    const preserveDried = lot.processing_stage === 'seco';
    const upd = {
      status: LOT_STATUS.Resting,
      ready_date: null,
      final_humidity: null,
      kg_green_actual: null,
      factor_rendimiento: null,
      conversion_factor: null,
    };
    if (!preserveDried) upd.kg_dried_output = null;
    const { error } = await sb.from('production_lots').update(upd).eq('id', lot_id);
    if (error) return serverErr('Undo failed', error.message);
    return ok({ undone: 'ready-from-resting' });
  }

  return badReq('event_kind no implementado', 'NOT_IMPLEMENTED');
});
