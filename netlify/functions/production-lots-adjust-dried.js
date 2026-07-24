'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { LOT_STATUS } = require('./_lib/schema');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');
const { revertOrdersIfNoLongerComplete } = require('./_lib/shipmentRevert');
const { checkDriedPlausibility } = require('./_lib/plausibility');
const { actorLabel } = require('./_lib/actor');

/**
 * POST /production-lots-adjust-dried  (finca, admin)
 * Body: { lot_id, kg_dried_output, reason }
 *
 * Corrige el peso seco de entrada a Punto Final de un bache ya
 * cerrado (Ready o Delivered). Casos típicos: el operario reporta
 * 3.000 kg y después descubre que había 500 kg más en bodega que
 * no fueron pesados.
 *
 * Efectos:
 *   1) Actualiza kg_dried_output.
 *   2) Escala kg_green_actual proporcionalmente para preservar
 *      la relación verde/seco con la que se cerró el bache.
 *   3) Recalcula conversion_factor (kg_input_initial / kg_dried_output).
 *   4) Anexa una línea de auditoría a notes:
 *        [Ajuste seco · <rol> · <fecha>] X → Y. Motivo: ...
 *   5) Si el bache estaba Delivered y el nuevo kg_dried_output
 *      deja SALDO (available > 0), reverte a Ready y limpia
 *      delivered_date. Órdenes que estaban Completed y ya no
 *      cumplen el threshold vuelven a InProduction (helper
 *      compartido con shipments-cancel).
 *
 * Validaciones:
 *   · Status ∈ {Ready, Delivered}
 *   · kg_dried_output > 0
 *   · reason ≥ 10 chars (auditoría real)
 *   · nuevo kg no puede quedar MENOR que lo ya despachado + mezclado
 *     (evita inventario negativo).
 */
exports.handler = requireAuth(['finca', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const { lot_id } = body || {};
  if (!lot_id) return badReq('lot_id required', 'LOT_ID_REQUIRED');
  const newDried = Number(body.kg_dried_output);
  if (!Number.isFinite(newDried) || newDried <= 0) {
    return badReq('kg_dried_output must be > 0', 'INVALID_DRIED');
  }
  const reasonTrimmed = (body.reason == null ? '' : String(body.reason)).trim().slice(0, 500);
  if (reasonTrimmed.length < 10) {
    return badReq('El motivo debe tener al menos 10 caracteres', 'REASON_TOO_SHORT');
  }

  const sb = getSupabase();
  const { data: lot, error: lErr } = await sb
    .from('production_lots').select('*').eq('id', lot_id).maybeSingle();
  if (lErr) return serverErr('Lookup failed', lErr.message);
  if (!lot) return notFound('Lot not found');
  if (lot.status !== LOT_STATUS.Ready && lot.status !== LOT_STATUS.Delivered) {
    return conflict(
      `Solo se puede ajustar un bache Ready o Delivered (actual: ${lot.status}).`,
      'INVALID_STATUS',
    );
  }

  // Lo que ya salió de bodega: mezclas + despachos (whole/partial-by-kg + partials).
  const [{ data: blendUse }, { data: shipLinks }] = await Promise.all([
    sb.from('lot_blend_components').select('kg_dried_used').eq('source_lot_id', lot_id),
    sb.from('shipment_lots').select('kg_dried_shipped, lot_partial_id, lot_partials(kg_dried)')
      .eq('production_lot_id', lot_id),
  ]);
  const blendedKg = (blendUse || []).reduce((s, r) => s + Number(r.kg_dried_used || 0), 0);
  const shippedKg = (shipLinks || []).reduce((s, r) => {
    if (r.kg_dried_shipped != null) return s + Number(r.kg_dried_shipped);
    if (r.lot_partials && r.lot_partials.kg_dried != null) return s + Number(r.lot_partials.kg_dried);
    return s;
  }, 0);
  const alreadyOut = round2(blendedKg + shippedKg);

  if (newDried + 0.01 < alreadyOut) {
    return conflict(
      `El nuevo valor (${newDried} kg) es menor que lo ya salido de bodega (${alreadyOut} kg entre despachos y mezclas). No se puede dejar inventario negativo.`,
      'NEW_LESS_THAN_OUT',
      { already_out_kg: alreadyOut },
    );
  }

  // Plausibility del nuevo peso: HARD (seco > entrada) rechaza;
  // conversión fuera del rango del stage pide confirmación.
  //
  // EXCEPCIÓN — mezclas: en un blend kg_input_initial no es un peso
  // físico de entrada sino una copia del seco total al crearlo
  // (lot-blend-create setea input = dried, stage 'seco'). La regla
  // "el café solo pierde peso al secar" no aplica: ajustar el peso
  // de una mezcla (p.ej. un componente mal registrado) mueve ambos
  // números juntos y la conversión se queda en 1×.
  const isBlend = !!lot.is_blend;
  if (!isBlend) {
    const check = checkDriedPlausibility({
      kgInputInitial: lot.kg_input_initial,
      kgDried: newDried,
      processingStage: lot.processing_stage,
    });
    if (check.hardError) return badReq(check.hardError, 'IMPLAUSIBLE_WEIGHT');
    if (check.confirmWarning && !body.override_plausibility) {
      return conflict(check.confirmWarning, 'PLAUSIBILITY_CONFIRM_REQUIRED',
        { conversion: check.conversion });
    }
  }

  // Escalar kg_green_actual proporcionalmente. Preserva la
  // relación verde/seco original — más seguro que recalcular con
  // el factor porque puede haber sido ajustado a mano.
  const oldDried = Number(lot.kg_dried_output || 0);
  const oldGreen = lot.kg_green_actual != null ? Number(lot.kg_green_actual) : null;
  let newGreen = oldGreen;
  if (oldDried > 0 && oldGreen != null) {
    newGreen = round2(oldGreen * (newDried / oldDried));
  } else if (lot.factor_rendimiento != null && Number(lot.factor_rendimiento) > 0) {
    // Fallback si no había kg_green_actual — fórmula estándar.
    newGreen = round2((newDried / Number(lot.factor_rendimiento)) * 70);
  }

  // Mezclas: kg_green_expected también escala con el seco (los blends
  // no tienen kg_green_actual y Punto Final cae a expected — sin esto
  // el verde quedaría stale tras el ajuste).
  let newGreenExpected = null;
  if (isBlend && oldDried > 0 && lot.kg_green_expected != null) {
    newGreenExpected = round2(Number(lot.kg_green_expected) * (newDried / oldDried));
  }

  // Recalcular conversion_factor. Para mezclas la entrada se mueve
  // junto al seco (mismo número por construcción) → conversión 1×.
  const initial = isBlend ? newDried : Number(lot.kg_input_initial || 0);
  const newConversion = initial > 0 && newDried > 0
    ? Math.round((initial / newDried) * 10000) / 10000
    : lot.conversion_factor;

  // Auditoría en notes
  const stamp = new Date().toISOString().slice(0, 10);
  const author = actorLabel(session, body);
  const auditLine = `[Ajuste seco · ${author} · ${stamp}] ${oldDried} kg → ${newDried} kg. Motivo: ${reasonTrimmed}`;
  const newNotes = lot.notes ? `${lot.notes}\n${auditLine}` : auditLine;

  // Revertir a Ready si Delivered y ahora hay saldo
  const newAvailable = round2(newDried - alreadyOut);
  const shouldRevert = lot.status === LOT_STATUS.Delivered && newAvailable > 0.01;
  const update = {
    kg_dried_output: newDried,
    kg_green_actual: newGreen,
    conversion_factor: newConversion,
    notes: newNotes,
  };
  // Mezclas: kg_input_initial acompaña al seco (ver excepción arriba)
  // y el expected escala.
  if (isBlend) update.kg_input_initial = newDried;
  if (newGreenExpected != null) update.kg_green_expected = newGreenExpected;
  if (shouldRevert) {
    update.status = LOT_STATUS.Ready;
    update.delivered_date = null;
  }

  const { data: updated, error: upErr } = await sb
    .from('production_lots').update(update).eq('id', lot_id).select().single();
  if (upErr) return serverErr('Update failed', upErr.message);

  // Si revertimos, cascada de órdenes que ya no cumplan
  let ordersReverted = [];
  if (shouldRevert) {
    try {
      ordersReverted = await revertOrdersIfNoLongerComplete(sb, [lot_id]);
    } catch (e) {
      // No abortamos por esto — el update ya se hizo. Loggeamos.
      console.warn('Order revert cascade failed', e.message);
    }
  }

  return ok({
    lot: updated,
    reverted_to_ready: shouldRevert,
    new_available_kg: Math.max(0, newAvailable),
    orders_reverted_to_in_production: ordersReverted,
  });
});

function round2(n) { return Math.round(Number(n) * 100) / 100; }
