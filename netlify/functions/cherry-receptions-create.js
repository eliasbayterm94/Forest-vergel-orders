'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { receptionNetKg, byproductRate, receptionAmountPaid } = require('./_lib/costPool');
const { created, badReq, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /cherry-receptions-create  (finca, admin)
 * Body: {
 *   supplier_id, received_date, entry_stage, kg_gross,
 *   price_per_kg?, discount_pct?, pool_key?, notes?,
 *   byproduct?: { kg, measurement, measured_stage?, kind?, notes? }
 * }
 *
 * One call for the whole "coffee arrived" screen: the delivery and the
 * floaters separated from it. Keeping them together means the net kg —
 * which is what carries the cost — is right from the first save
 * instead of after a second step somebody may forget.
 *
 * price_per_kg must be absent for an 'own' supplier and present for a
 * third party; the database enforces that, this endpoint just returns
 * a readable message.
 *
 * discount_pct is the negotiated reduction when a delivery arrives
 * heavy in floaters. The response reports the floater rate against it:
 * the discount that leaves cost per net kg unchanged equals the
 * floater rate exactly.
 */
const STAGES = new Set(['cereza', 'despulpado', 'seco']);
const MEASUREMENTS = new Set(['weighed', 'estimated']);

exports.handler = requireAuth(['finca', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const errors = [];

  const supplier_id = body && body.supplier_id;
  if (!supplier_id) errors.push('supplier_id requerido');

  const received_date = body && body.received_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(received_date || '')) errors.push('received_date debe ser YYYY-MM-DD');

  const entry_stage = body && body.entry_stage;
  if (!STAGES.has(entry_stage)) errors.push('entry_stage debe ser cereza, despulpado o seco');

  const kg_gross = Number(body && body.kg_gross);
  if (!Number.isFinite(kg_gross) || kg_gross <= 0) errors.push('kg_gross debe ser > 0');

  let price_per_kg = null;
  if (body && body.price_per_kg != null && body.price_per_kg !== '') {
    price_per_kg = Number(body.price_per_kg);
    if (!Number.isFinite(price_per_kg) || price_per_kg < 0) errors.push('price_per_kg debe ser >= 0');
  }

  let discount_pct = 0;
  if (body && body.discount_pct != null && body.discount_pct !== '') {
    discount_pct = Number(body.discount_pct);
    if (!Number.isFinite(discount_pct) || discount_pct < 0 || discount_pct > 1) {
      errors.push('discount_pct debe estar entre 0 y 1');
    }
  }

  const pool_key = body && body.pool_key
    ? String(body.pool_key).trim().toLowerCase().slice(0, 60) || null : null;

  // By-product, optional but validated as a block.
  let bp = null;
  if (body && body.byproduct && body.byproduct.kg != null && body.byproduct.kg !== '') {
    const kg = Number(body.byproduct.kg);
    if (!Number.isFinite(kg) || kg <= 0) errors.push('byproduct.kg debe ser > 0');
    else if (kg >= kg_gross) errors.push('byproduct.kg no puede ser >= kg_gross (no quedaría café usable)');
    const measurement = body.byproduct.measurement;
    if (!MEASUREMENTS.has(measurement)) errors.push("byproduct.measurement debe ser 'weighed' o 'estimated'");
    const measured_stage = body.byproduct.measured_stage || entry_stage;
    if (!STAGES.has(measured_stage)) errors.push('byproduct.measured_stage inválido');
    if (errors.length === 0) {
      bp = {
        kg, measurement, measured_stage,
        kind: body.byproduct.kind ? String(body.byproduct.kind).trim().slice(0, 40) : 'floaters',
        notes: body.byproduct.notes ? String(body.byproduct.notes).trim().slice(0, 500) || null : null,
      };
    }
  }

  if (errors.length) return badReq(errors.join('; '), 'VALIDATION_ERROR');

  const sb = getSupabase();
  const actor = (session && (session.username || session.role)) || null;

  const { data: reception, error: insErr } = await sb
    .from('cherry_receptions')
    .insert({
      supplier_id, received_date, entry_stage, kg_gross,
      price_per_kg, discount_pct, pool_key,
      notes: body.notes ? String(body.notes).trim().slice(0, 1000) || null : null,
      created_by: actor,
    })
    .select('*').single();

  if (insErr) {
    const m = insErr.message || '';
    // Surface the database's two integrity rules in plain language.
    if (/carry no purchase price/i.test(m)) {
      return badReq(
        'El café propio no lleva precio de compra: se costea con la tarifa T2. Deja el precio vacío.',
        'OWN_SUPPLIER_NO_PRICE',
      );
    }
    if (/needs price_per_kg/i.test(m)) {
      return badReq('Una compra a un tercero necesita precio por kg.', 'PRICE_REQUIRED');
    }
    return serverErr('No se pudo registrar la recepción', m);
  }

  // By-product in the same operation. If this fails the reception is
  // already in, so we say so explicitly instead of leaving the user
  // thinking nothing was saved.
  let byproduct = null;
  if (bp) {
    const { data: bpRow, error: bpErr } = await sb
      .from('lot_byproducts')
      .insert({
        kind: bp.kind,
        source_reception_id: reception.id,
        measured_stage: bp.measured_stage,
        kg: bp.kg,
        measurement: bp.measurement,
        separated_on: received_date,
        notes: bp.notes,
        created_by: actor,
      })
      .select('*').single();
    if (bpErr) {
      return serverErr(
        `La recepción ${reception.reception_code} quedó registrada, pero no se pudo guardar el subproducto. `
        + 'Agrégalo desde la recepción.',
        bpErr.message,
      );
    }
    byproduct = bpRow;
  }

  const bps = byproduct ? [byproduct] : [];
  return created({
    reception: {
      ...reception,
      amount_paid_cop: receptionAmountPaid(reception),
      kg_net: receptionNetKg(reception, bps),
      byproducts: bps,
      byproduct_summary: byproductRate(reception, bps),
    },
  });
});
