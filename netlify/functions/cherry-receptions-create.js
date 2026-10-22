'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { receptionNetKg, byproductRate, receptionAmountPaid } = require('./_lib/costPool');
const { isMissingColumn } = require('./_lib/costingData');
const { created, badReq, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /cherry-receptions-create  (finca, admin)
 * Body: {
 *   supplier_id, received_date, entry_stage, kg_gross,
 *   kg_scale_gross?, sacks_count?, tare_per_sack_kg?,
 *   cherry_to_pulped_ratio?, brix_pct?, ph?,
 *   price_per_kg?, discount_pct?, pool_key?, notes?,
 *   byproduct?: { kg, measurement, measured_stage?, kind?, notes? }
 * }
 *
 * kg_gross is the weight of COFFEE and the base the payment is
 * computed on. When the weighing detail comes too, kg_gross must equal
 * kg_scale_gross − sacks_count × tare_per_sack_kg: the screen does
 * that arithmetic, and this re-checks it, because digitising the scale
 * reading as the coffee weight would spread the cost over the sacks
 * and understate cost per kg with nothing failing.
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
// Standard empty sack. Stored per reception, so changing the standard
// later cannot rewrite the arithmetic of a delivery already recorded.
const DEFAULT_TARE_PER_SACK_KG = 0.35;

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

  // Weighing detail: optional, but all-or-nothing, because a chain
  // missing a link cannot be verified.
  const optNum = (v) => (v == null || v === '' ? null : Number(v));
  const kg_scale_gross = optNum(body && body.kg_scale_gross);
  const sacks_count = optNum(body && body.sacks_count);
  let tare_per_sack_kg = optNum(body && body.tare_per_sack_kg);

  const weighingParts = [kg_scale_gross, sacks_count].filter((v) => v != null).length;
  if (weighingParts === 1) {
    errors.push('Para el detalle de pesaje hacen falta kg_scale_gross y sacks_count juntos');
  }
  if (kg_scale_gross != null && (!Number.isFinite(kg_scale_gross) || kg_scale_gross <= 0)) {
    errors.push('kg_scale_gross debe ser > 0');
  }
  if (sacks_count != null && (!Number.isInteger(sacks_count) || sacks_count < 0)) {
    errors.push('sacks_count debe ser un entero >= 0');
  }
  if (weighingParts === 2) {
    if (tare_per_sack_kg == null) tare_per_sack_kg = DEFAULT_TARE_PER_SACK_KG;
    if (!Number.isFinite(tare_per_sack_kg) || tare_per_sack_kg < 0 || tare_per_sack_kg > 5) {
      errors.push('tare_per_sack_kg debe estar entre 0 y 5');
    } else {
      const expected = Math.round((kg_scale_gross - sacks_count * tare_per_sack_kg) * 100) / 100;
      if (expected <= 0) {
        errors.push('La tara de las lonas se come toda la entrega: revisa lonas o peso en balanza');
      } else if (Math.abs(expected - kg_gross) > 0.01) {
        errors.push(`Los kg de café deben ser ${expected.toFixed(2)} (balanza ${kg_scale_gross} − ${sacks_count} lonas × ${tare_per_sack_kg})`);
      }
    }
  } else {
    tare_per_sack_kg = null;
  }

  // Quality readings. Pure traceability: none of this enters the cost.
  const cherry_to_pulped_ratio = optNum(body && body.cherry_to_pulped_ratio);
  if (cherry_to_pulped_ratio != null
      && (!Number.isFinite(cherry_to_pulped_ratio) || cherry_to_pulped_ratio <= 0 || cherry_to_pulped_ratio > 1)) {
    errors.push('cherry_to_pulped_ratio debe ser una fracción entre 0 y 1 (0.544 = 54.4%)');
  }
  const brix_pct = optNum(body && body.brix_pct);
  if (brix_pct != null && (!Number.isFinite(brix_pct) || brix_pct < 0 || brix_pct > 100)) {
    errors.push('brix_pct debe estar entre 0 y 100');
  }
  const ph = optNum(body && body.ph);
  if (ph != null && (!Number.isFinite(ph) || ph < 0 || ph > 14)) {
    errors.push('ph debe estar entre 0 y 14');
  }

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

  const core = {
    supplier_id, received_date, entry_stage, kg_gross,
    price_per_kg, discount_pct, pool_key,
    notes: body.notes ? String(body.notes).trim().slice(0, 1000) || null : null,
    created_by: actor,
  };
  // Weighing and quality live in migration 0053. Migrations here are
  // applied by hand, so if the code lands first the reception must
  // still be saveable: the retry drops the new fields rather than
  // losing the delivery. It reports what it could not store.
  const extended = {
    ...core,
    kg_scale_gross, sacks_count, tare_per_sack_kg,
    cherry_to_pulped_ratio, brix_pct, ph,
  };

  let { data: reception, error: insErr } = await sb
    .from('cherry_receptions').insert(extended).select('*').single();

  let weighing_not_stored = false;
  if (insErr && isMissingWeighingColumn(insErr)) {
    weighing_not_stored = true;
    ({ data: reception, error: insErr } = await sb
      .from('cherry_receptions').insert(core).select('*').single());
  }

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
  const out = {
    reception: {
      ...reception,
      amount_paid_cop: receptionAmountPaid(reception),
      kg_net: receptionNetKg(reception, bps),
      byproducts: bps,
      byproduct_summary: byproductRate(reception, bps),
    },
  };
  // The delivery and its payment are correct either way; only the
  // weighing and lab detail was dropped, and the screen says so.
  if (weighing_not_stored) {
    out.warning = 'La recepción quedó guardada, pero el detalle de pesaje y calidad no: falta aplicar la migración 0053.';
    out.warning_code = 'WEIGHING_COLUMNS_MISSING';
  }
  return created(out);
});

/**
 * The weighing and quality columns, as one list. Delegates to the
 * shared predicate so there is a single definition of "this column is
 * not there yet".
 */
const WEIGHING_COLS = [
  'kg_scale_gross', 'sacks_count', 'tare_per_sack_kg',
  'cherry_to_pulped_ratio', 'brix_pct', 'ph',
];
function isMissingWeighingColumn(error) {
  return isMissingColumn(error, WEIGHING_COLS);
}

exports.isMissingWeighingColumn = isMissingWeighingColumn;
