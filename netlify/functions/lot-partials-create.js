'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { LOT_STATUS } = require('./_lib/schema');
const { created, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /lot-partials-create  (finca, admin)
 * Body:
 *   production_lot_id   uuid
 *   parcial_letter      'A' | 'B' | 'C' | 'D' | 'E' | 'F'
 *   kg_dried            number > 0
 *   factor_rendimiento  number > 0
 *   notes               string (optional)
 *
 * Solo se permite agregar parciales mientras el lote esta en Drying.
 * El kg_green_yield del parcial se calcula en la base ((kg/factor)*70).
 */
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

exports.handler = requireAuth(['finca', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const production_lot_id  = body.production_lot_id;
  const parcial_letter     = (body.parcial_letter || '').toString().trim().toUpperCase();
  const kg_dried           = Number(body.kg_dried);
  const factor_rendimiento = Number(body.factor_rendimiento);
  const notes              = body.notes == null ? null : String(body.notes);

  const errors = [];
  if (!production_lot_id) errors.push('production_lot_id required');
  if (!LETTERS.includes(parcial_letter)) errors.push('parcial_letter must be A-F');
  if (!Number.isFinite(kg_dried) || kg_dried <= 0) errors.push('kg_dried must be > 0');
  if (!Number.isFinite(factor_rendimiento) || factor_rendimiento <= 0) errors.push('factor_rendimiento must be > 0');
  if (errors.length) return badReq(errors.join('; '), 'VALIDATION_ERROR');

  const sb = getSupabase();
  const { data: lot, error: loadErr } = await sb
    .from('production_lots').select('id, status').eq('id', production_lot_id).maybeSingle();
  if (loadErr) return serverErr('Lookup failed', loadErr.message);
  if (!lot) return notFound('Lot not found');
  if (lot.status !== LOT_STATUS.Drying) {
    return conflict(
      `Solo se pueden agregar parciales en estado Drying (lote en ${lot.status})`,
      'INVALID_LOT_STATUS',
    );
  }

  const { data: inserted, error: insErr } = await sb
    .from('lot_partials').insert({
      production_lot_id,
      parcial_letter,
      kg_dried,
      factor_rendimiento,
      notes,
      created_by: session.role,
    }).select().single();
  if (insErr) {
    if (/unique|duplicate/i.test(insErr.message)) {
      return conflict(`Ya existe un parcial ${parcial_letter} en este lote`, 'PARCIAL_LETTER_TAKEN');
    }
    return serverErr('Failed to create partial', insErr.message);
  }
  return created({ partial: inserted });
});
