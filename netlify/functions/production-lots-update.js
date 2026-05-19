'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /production-lots-update  (finca, admin)
 * Body: { lot_id, fields }
 * Updatable fields (whitelist):
 *   bache_code, start_date, kg_input_initial, notes,
 *   fermentation_hours, drying_start_date, ready_date, delivered_date,
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
  'fermentation_hours', 'drying_start_date', 'ready_date', 'delivered_date',
  'kg_dried_output', 'factor_rendimiento', 'kg_green_actual',
  'infusion_id', 'infusion_pct',
]);

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
