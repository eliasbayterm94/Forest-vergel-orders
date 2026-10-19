'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { created, badReq, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /lot-byproducts-create  (finca, admin)
 * Body: { source_reception_id | source_lot_id, kg, measurement,
 *         measured_stage, separated_on?, kind?, byproduct_lot_id?, notes? }
 *
 * Separating by-product after the fact, or from a lot of the farm's own
 * coffee, which has no purchase reception to hang it on.
 *
 * Zero cost by policy; the usable coffee absorbs the whole amount paid.
 * measurement keeps weighed and estimated apart: floaters that go
 * straight to the re-pulper can only be estimated, and an estimate must
 * never read as a measured fact.
 */
const STAGES = new Set(['cereza', 'despulpado', 'seco']);
const MEASUREMENTS = new Set(['weighed', 'estimated']);

exports.handler = requireAuth(['finca', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const recId = (body && body.source_reception_id) || null;
  const lotId = (body && body.source_lot_id) || null;
  if (!recId && !lotId) return badReq('Indica source_reception_id o source_lot_id', 'SOURCE_REQUIRED');
  if (recId && lotId) {
    return badReq('Solo uno de source_reception_id o source_lot_id', 'SOURCE_AMBIGUOUS');
  }

  const kg = Number(body && body.kg);
  if (!Number.isFinite(kg) || kg <= 0) return badReq('kg debe ser > 0', 'INVALID_KG');

  if (!MEASUREMENTS.has(body && body.measurement)) {
    return badReq("measurement debe ser 'weighed' o 'estimated'", 'INVALID_MEASUREMENT');
  }
  if (!STAGES.has(body && body.measured_stage)) {
    return badReq('measured_stage debe ser cereza, despulpado o seco', 'INVALID_STAGE');
  }

  const separated_on = (body && body.separated_on) || null;
  if (separated_on && !/^\d{4}-\d{2}-\d{2}$/.test(separated_on)) {
    return badReq('separated_on debe ser YYYY-MM-DD', 'INVALID_DATE');
  }

  const sb = getSupabase();

  // Separating more than came in would make net kg negative, which the
  // pool would then charge against nothing.
  if (recId) {
    const { data: rec, error: recErr } = await sb
      .from('cherry_receptions').select('kg_gross').eq('id', recId).maybeSingle();
    if (recErr) return serverErr('Lookup failed', recErr.message);
    if (!rec) return badReq('Recepción no encontrada', 'RECEPTION_NOT_FOUND');

    const { data: prior, error: pErr } = await sb
      .from('lot_byproducts').select('kg').eq('source_reception_id', recId);
    if (pErr) return serverErr('Lookup failed', pErr.message);
    const already = (prior || []).reduce((s, r) => s + Number(r.kg || 0), 0);
    if (already + kg >= Number(rec.kg_gross)) {
      return badReq(
        `La recepción trajo ${rec.kg_gross} kg y ya tiene ${already} kg de subproducto; `
        + `agregar ${kg} kg no dejaría café usable.`,
        'EXCEEDS_GROSS',
      );
    }
  }

  const { data, error } = await sb
    .from('lot_byproducts')
    .insert({
      kind: body.kind ? String(body.kind).trim().slice(0, 40) : 'floaters',
      source_reception_id: recId,
      source_lot_id: lotId,
      measured_stage: body.measured_stage,
      kg,
      measurement: body.measurement,
      byproduct_lot_id: body.byproduct_lot_id || null,
      separated_on: separated_on || new Date().toISOString().slice(0, 10),
      notes: body.notes ? String(body.notes).trim().slice(0, 500) || null : null,
      created_by: (session && (session.username || session.role)) || null,
    })
    .select('*').single();
  if (error) return serverErr('No se pudo registrar el subproducto', error.message);
  return created({ byproduct: data });
});
