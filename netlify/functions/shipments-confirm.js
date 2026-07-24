'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');
const { bogotaToday } = require('./_lib/bogotaTime');
const { driedLedger, round2 } = require('./_lib/lotInventory');
const { actorLabel } = require('./_lib/actor');
const { applyDeliveryAndCompletion } = require('./_lib/shipmentDeliver');
const { patchDraft } = require('./_lib/shipmentDraft');

/**
 * POST /shipments-confirm  (finca, admin)
 * Body: { shipment_id, header?: {...}, lines?: [{id, ...logística}] }
 *
 * Confirma un despacho en BORRADOR y lo vuelve definitivo:
 *   1) (opcional) completa la logística que faltaba (header/lines).
 *   2) revalida que lo apartado siga cabiendo en el disponible.
 *   3) status → 'confirmed', confirmed_at = now.
 *   4) corre la cascada de entrega (baches Delivered + pedidos
 *      completados) — misma fuente única que shipments-create.
 *
 * El apartado del borrador (held) se convierte en despachado sin
 * reescribir las líneas: la clasificación es por el status del
 * despacho.
 */
exports.handler = requireAuth(['finca', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const shipment_id = body.shipment_id;
  if (!shipment_id) return badReq('shipment_id required', 'SHIPMENT_ID_REQUIRED');

  const sb = getSupabase();

  const { data: ship, error: sErr } = await sb
    .from('shipments')
    .select(`
      id, shipment_code, status,
      shipment_lots (
        id, production_lot_id, lot_partial_id, kg_dried_shipped, kg_dried_merma,
        production_lots (
          id, bache_code, lot_code, kg_dried_output, notes,
          lot_partials ( id, rejected_at )
        )
      )
    `)
    .eq('id', shipment_id).maybeSingle();
  if (sErr) return serverErr('Lookup failed', sErr.message);
  if (!ship) return notFound('Shipment not found');
  if (ship.status !== 'draft') {
    return conflict('Este despacho ya está confirmado', 'NOT_A_DRAFT');
  }

  const myLines = ship.shipment_lots || [];
  if (myLines.length === 0) return conflict('El borrador no tiene líneas', 'EMPTY_DRAFT');

  // Completar logística que faltaba (si el confirm trae cambios).
  if (body.header || body.lines) {
    const r = await patchDraft(sb, shipment_id, { header: body.header, lines: body.lines });
    if (!r.ok) {
      if (['UPDATE_FAILED', 'LINE_LOOKUP_FAILED', 'LINE_UPDATE_FAILED'].includes(r.code)) {
        return serverErr(r.message, r.message);
      }
      return badReq(r.message, r.code);
    }
  }

  const lotById = new Map();
  for (const sl of myLines) {
    const l = sl.production_lots;
    if (l && !lotById.has(l.id)) lotById.set(l.id, l);
  }
  const lotIds = [...lotById.keys()];

  // Kg consumido en mezclas.
  const { data: blendUse } = await sb
    .from('lot_blend_components').select('source_lot_id, kg_dried_used').in('source_lot_id', lotIds);
  const blendedByLot = new Map();
  for (const r of blendUse || []) {
    blendedByLot.set(r.source_lot_id, (blendedByLot.get(r.source_lot_id) || 0) + Number(r.kg_dried_used || 0));
  }

  // Despachado CONFIRMADO por OTROS despachos (para revalidar y para
  // la decisión de entrega). Excluye este borrador.
  const { data: otherLinks } = await sb
    .from('shipment_lots')
    .select('shipment_id, production_lot_id, lot_partial_id, kg_dried_shipped, kg_dried_merma, shipments(status)')
    .in('production_lot_id', lotIds);
  const priorShippedWholeByLot = new Map();
  const priorShippedPartialIds = new Set();
  for (const x of otherLinks || []) {
    if (x.shipment_id === shipment_id) continue;
    if (x.shipments && x.shipments.status === 'draft') continue;   // otro borrador no cuenta
    if (x.lot_partial_id != null) { priorShippedPartialIds.add(x.lot_partial_id); continue; }
    const kg = Number(x.kg_dried_shipped || 0) + Number(x.kg_dried_merma || 0);
    priorShippedWholeByLot.set(x.production_lot_id, (priorShippedWholeByLot.get(x.production_lot_id) || 0) + kg);
  }

  // Kg de ESTE borrador (que se vuelve despachado) + notas de peso real.
  const today = bogotaToday();
  const newlyShippedWholeByLot = new Map();
  const newlyShippedPartialIds = new Set();
  const notesByLot = new Map();
  for (const sl of myLines) {
    if (sl.lot_partial_id != null) { newlyShippedPartialIds.add(sl.lot_partial_id); continue; }
    const kg = Number(sl.kg_dried_shipped || 0) + Number(sl.kg_dried_merma || 0);
    newlyShippedWholeByLot.set(sl.production_lot_id, (newlyShippedWholeByLot.get(sl.production_lot_id) || 0) + kg);
    if (sl.kg_dried_merma != null && Math.abs(Number(sl.kg_dried_merma)) >= 0.01) {
      const merma = Number(sl.kg_dried_merma);
      const registered = round2(Number(sl.kg_dried_shipped || 0) + merma);
      const kind = merma > 0 ? 'merma' : 'ganancia';
      notesByLot.set(sl.production_lot_id,
        `[Despacho total · ${actorLabel(session, body)} · ${today}] ` +
        `Peso báscula: ${round2(Number(sl.kg_dried_shipped || 0))} kg vs ${registered} kg registrados ` +
        `(${kind} de ${Math.abs(merma)} kg por humedad). Despacho ${ship.shipment_code || ship.id}.`);
    }
  }

  // Revalidar: lo confirmado por otros + lo de este borrador no debe
  // exceder el disponible (p.ej. si un ajuste de peso seco redujo el
  // bache mientras el borrador esperaba).
  for (const [lotId, lot] of lotById) {
    if ((lot.lot_partials || []).length > 0) continue;   // por parciales: no aplica el tope por kg
    const committed = (priorShippedWholeByLot.get(lotId) || 0) + (newlyShippedWholeByLot.get(lotId) || 0);
    const capacity = driedLedger({
      kgDriedOutput: lot.kg_dried_output,
      blendedKg: blendedByLot.get(lotId) || 0,
    }).available;   // total - blended (sin descontar despachos)
    if (committed > capacity + 0.01) {
      return conflict(
        `Lote ${lot.bache_code || lot.lot_code}: lo despachado (${round2(committed)} kg) supera el disponible ` +
        `(${round2(capacity)} kg). Ajusta el borrador antes de confirmar.`,
        'EXCEEDS_AVAILABLE',
      );
    }
  }

  // Flip a confirmado ANTES de la cascada (para que el inventario ya
  // cuente estas líneas como despachadas, no apartadas).
  const { error: upErr } = await sb
    .from('shipments')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
    .eq('id', shipment_id);
  if (upErr) return serverErr('Failed to confirm shipment', upErr.message);

  let completions;
  try {
    ({ completions } = await applyDeliveryAndCompletion(sb, {
      lots: [...lotById.values()],
      today,
      blendedByLot,
      priorShippedWholeByLot,
      newlyShippedWholeByLot,
      priorShippedPartialIds,
      newlyShippedPartialIds,
      notesByLot,
    }));
  } catch (e) {
    return serverErr('Delivery cascade failed', e.message);
  }

  return ok({ shipment: { id: ship.id, shipment_code: ship.shipment_code, status: 'confirmed' }, completions });
});
