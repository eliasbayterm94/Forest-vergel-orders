'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');
const { inputToGreen, INPUT_STAGE_DIVISORS } = require('./_lib/processYields');

/**
 * POST /production-lots-update  (finca, admin)
 * Body: { lot_id, fields }
 * Updatable fields (whitelist):
 *   bache_code, start_date, kg_input_initial, notes,
 *   process_type, fermentation_hours,
 *   drying_start_date, ready_date, delivered_date,
 *   kg_dried_output, factor_rendimiento, kg_green_actual,
 *   infusion_id, infusion_pct
 *
 * variety_ids: opcional, lista completa. Si viene reemplaza la
 * relación production_lot_varieties (delete + insert) para el bache.
 *
 * Status changes go through production-lots-update-status.
 */
const ALLOWED = new Set([
  'bache_code', 'start_date', 'kg_input_initial', 'notes',
  'process_type', 'fermentation_hours',
  'drying_start_date', 'drying_locations',
  'ready_date', 'delivered_date',
  'kg_dried_output', 'factor_rendimiento', 'kg_green_actual',
  'final_humidity',
  'infusion_id', 'infusion_pct',
]);
const PROCESS_TYPES = new Set(['Natural', 'Honey', 'Lavado']);
const DRYING_LOCATION_OPTIONS = new Set(['Silos', 'Patio']);

exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const lot_id = body.lot_id;
  if (!lot_id) return badReq('lot_id required', 'LOT_ID_REQUIRED');
  const fields = body.fields || {};
  const varietyIds = Array.isArray(body.variety_ids) ? [...new Set(body.variety_ids)] : null;

  const update = {};
  for (const k of Object.keys(fields)) {
    if (ALLOWED.has(k)) update[k] = fields[k];
  }
  if (Object.keys(update).length === 0 && varietyIds === null) {
    return badReq('No updatable fields provided', 'NO_FIELDS');
  }

  if (update.bache_code != null) {
    update.bache_code = String(update.bache_code).trim();
    if (!update.bache_code) return badReq('bache_code cannot be empty', 'BACHE_CODE_REQUIRED');
    if (update.bache_code.length > 60) return badReq('bache_code too long (max 60)', 'BACHE_CODE_TOO_LONG');
  }
  if (update.start_date != null && !/^\d{4}-\d{2}-\d{2}$/.test(update.start_date)) {
    return badReq('start_date must be YYYY-MM-DD', 'INVALID_DATE');
  }
  if (update.kg_input_initial != null) {
    const n = Number(update.kg_input_initial);
    if (!Number.isFinite(n) || n <= 0) return badReq('kg_input_initial must be > 0', 'INVALID_KG');
    update.kg_input_initial = n;
  }
  if (update.process_type != null && !PROCESS_TYPES.has(update.process_type)) {
    return badReq('process_type inválido', 'INVALID_PROCESS');
  }
  if (update.fermentation_hours != null) {
    const n = Number(update.fermentation_hours);
    if (!Number.isFinite(n) || n < 0) return badReq('fermentation_hours must be >= 0', 'INVALID_HOURS');
    update.fermentation_hours = n;
  }
  // Humedad final de la matriz (0-100)
  if (update.final_humidity !== undefined && update.final_humidity !== null && update.final_humidity !== '') {
    const n = Number(update.final_humidity);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return badReq('final_humidity debe estar entre 0 y 100', 'INVALID_HUMIDITY');
    }
    update.final_humidity = Math.round(n * 100) / 100;
  } else if (update.final_humidity === '') {
    update.final_humidity = null;
  }
  // Marquesinas de secado (array de strings, subset de {Silos, Patio})
  if (update.drying_locations !== undefined && update.drying_locations !== null) {
    if (!Array.isArray(update.drying_locations)) {
      return badReq('drying_locations must be array', 'INVALID_LOCATIONS');
    }
    const cleaned = [...new Set(update.drying_locations.map((s) => String(s).trim()).filter(Boolean))];
    for (const x of cleaned) {
      if (!DRYING_LOCATION_OPTIONS.has(x)) {
        return badReq(`drying_locations: valor inválido "${x}". Opciones: Silos, Patio.`, 'INVALID_LOCATIONS');
      }
    }
    update.drying_locations = cleaned;
  }
  // Pesos al cerrar el bache
  for (const f of ['kg_dried_output', 'factor_rendimiento', 'kg_green_actual']) {
    if (update[f] !== undefined && update[f] !== null && update[f] !== '') {
      const n = Number(update[f]);
      if (!Number.isFinite(n) || n < 0) return badReq(`${f} debe ser >= 0`, 'INVALID_KG');
      update[f] = n;
    } else if (update[f] === '') {
      update[f] = null;
    }
  }
  // Validar fechas de etapa
  for (const f of ['drying_start_date', 'ready_date', 'delivered_date']) {
    if (update[f] != null && update[f] !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(update[f])) {
      return badReq(`${f} must be YYYY-MM-DD`, 'INVALID_DATE');
    }
    if (update[f] === '') update[f] = null;
  }
  if (varietyIds !== null && varietyIds.length === 0) {
    return badReq('Al menos una variedad es requerida', 'VARIETIES_REQUIRED');
  }

  // Infusion: ambos o ninguno (consistente con el CHECK de la BD)
  const hasInfId  = Object.prototype.hasOwnProperty.call(update, 'infusion_id');
  const hasInfPct = Object.prototype.hasOwnProperty.call(update, 'infusion_pct');
  if (hasInfId || hasInfPct) {
    const id  = update.infusion_id;
    const pct = update.infusion_pct == null ? null : Number(update.infusion_pct);
    const both = (id != null && id !== '') && (pct != null);
    const none = (id == null || id === '') && (pct == null);
    if (!both && !none) {
      return badReq('infusion_id e infusion_pct deben actualizarse juntos', 'INFUSION_INCONSISTENT');
    }
    if (both && (!Number.isFinite(pct) || pct <= 0 || pct > 100)) {
      return badReq('infusion_pct debe estar en (0, 100]', 'INFUSION_PCT_RANGE');
    }
    update.infusion_id  = none ? null : id;
    update.infusion_pct = none ? null : pct;
  }

  const sb = getSupabase();

  // Si cambia kg_input_initial, recalcular los campos derivados
  // (kg_cherry_input/kg_despulpado_input/kg_dried_output según stage,
  // y kg_green_expected). Sin esto, la tabla de producción seguía
  // mostrando los valores viejos.
  if (update.kg_input_initial != null) {
    const { data: cur } = await sb
      .from('production_lots')
      .select('processing_stage, kg_cherry_input, kg_despulpado_input, kg_dried_output')
      .eq('id', lot_id).maybeSingle();
    if (!cur) return notFound('Lot not found');
    const stage = cur.processing_stage;
    if (stage && INPUT_STAGE_DIVISORS[stage]) {
      update.kg_green_expected = inputToGreen(update.kg_input_initial, stage);
      if (stage === 'cereza')         update.kg_cherry_input      = update.kg_input_initial;
      else if (stage === 'despulpado') update.kg_despulpado_input = update.kg_input_initial;
      // Para stage 'seco' solo recalculamos kg_dried_output si el
      // bache aún no se cerró (kg_dried_output == kg_input_initial al
      // crear). Si ya hay un kg_dried_output distinto, respetamos
      // el del usuario porque puede haberlo medido post-secado.
      else if (stage === 'seco' && (cur.kg_dried_output == null
               || Number(cur.kg_dried_output) === Number(cur.kg_cherry_input || 0)
               || Number(cur.kg_dried_output) === Number(cur.kg_despulpado_input || 0))) {
        update.kg_dried_output = update.kg_input_initial;
      }
    }
  }

  let updated = null;
  if (Object.keys(update).length > 0) {
    const { data, error } = await sb
      .from('production_lots').update(update).eq('id', lot_id).select().maybeSingle();
    if (error) {
      if (/bache_code/i.test(error.message) && /unique|duplicate/i.test(error.message)) {
        return conflict('Ya existe un lote con ese código de bache', 'BACHE_CODE_TAKEN');
      }
      return serverErr('Update failed', error.message);
    }
    if (!data) return notFound('Lot not found');
    updated = data;
  }

  // Variedades: si vienen, reemplazamos la relación. Borramos las que
  // sobran e insertamos las nuevas en una sola transacción lógica.
  if (varietyIds !== null) {
    const { data: lotCheck } = await sb
      .from('production_lots').select('id').eq('id', lot_id).maybeSingle();
    if (!lotCheck) return notFound('Lot not found');
    const { data: current } = await sb
      .from('production_lot_varieties').select('variety_id').eq('production_lot_id', lot_id);
    const currentSet = new Set((current || []).map((r) => r.variety_id));
    const nextSet = new Set(varietyIds);
    const toRemove = [...currentSet].filter((id) => !nextSet.has(id));
    const toAdd    = varietyIds.filter((id) => !currentSet.has(id));
    if (toRemove.length > 0) {
      const { error: delErr } = await sb
        .from('production_lot_varieties').delete()
        .eq('production_lot_id', lot_id).in('variety_id', toRemove);
      if (delErr) return serverErr('Variety unlink failed', delErr.message);
    }
    if (toAdd.length > 0) {
      const rows = toAdd.map((variety_id) => ({ production_lot_id: lot_id, variety_id }));
      const { error: insErr } = await sb.from('production_lot_varieties').insert(rows);
      if (insErr) return serverErr('Variety link failed', insErr.message);
    }
    if (!updated) {
      const { data } = await sb
        .from('production_lots').select().eq('id', lot_id).maybeSingle();
      updated = data;
    }
  }

  return ok({ lot: updated });
});
