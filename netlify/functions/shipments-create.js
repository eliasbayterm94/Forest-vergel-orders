'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { LOT_STATUS, ORDER_STATUS } = require('./_lib/schema');
const { ok, badReq, conflict, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');
const { notifyOrderCompleted } = require('./_lib/notifications');
const { bogotaToday } = require('./_lib/bogotaTime');
const { driedLedger, round2 } = require('./_lib/lotInventory');
const { actorLabel } = require('./_lib/actor');

/**
 * POST /shipments-create  (finca, admin)
 *
 * Body (preferred shape):
 *   shipment_code  (optional, auto DSP-YYYY-NNNN)
 *   shipment_date  YYYY-MM-DD (default: today Bogota)
 *   notes          string (optional)
 *   destino_kind   'Vertical' | 'Tribox' | 'Trillanova' | 'Otro' (optional)
 *   destino_other  string (required when destino_kind='Otro')
 *   driver_cedula  string (optional)
 *   driver_placas  string (optional)
 *   driver_name    string (optional)
 *   items          [
 *     { production_lot_id: uuid, partial_ids: null | [uuid],
 *       codigo_trilladora?: string, codigo_mezcla?: string,
 *       num_sacos?: int, num_lonas?: int,
 *       empaque_interior?: 'grainpro'|'bolsa', color_cinta?: '#rrggbb',
 *       observaciones?: string, partials_merged?: boolean,
 *       kg_dried_to_ship?: number, close_lot?: boolean, split?: boolean }
 *   ]
 *   override_peso_real?: boolean
 *
 *   - partial_ids null/empty → ship the whole lot. Only allowed when
 *     the lot has no registered partials.
 *   - partial_ids array     → ship those specific partials. Required
 *     when the lot has any partial.
 *
 *   Peso real de báscula (close_lot=true + kg_dried_to_ship):
 *   despacho TOTAL cuyo peso real difiere del registrado por humedad.
 *   La línea guarda el kg real y la diferencia queda en
 *   kg_dried_merma (cuenta como salida de bodega → disponible 0) y
 *   anotada en la bitácora del bache. El bache pasa a Delivered.
 *   Diferencias > 3% exigen override_peso_real=true
 *   (409 PESO_REAL_CONFIRM_REQUIRED); báscula por encima del
 *   registro se tolera hasta +3% (más allá: EXCEEDS_AVAILABLE).
 *
 *   División P1/P2 (varios items whole-mode del mismo bache):
 *   cada línea lleva su propio kg y empaque, y recibe split_label
 *   automático (P1, P2, …). Si el bache ya tiene líneas etiquetadas
 *   de despachos anteriores, la numeración continúa (P3, …) — así
 *   una división puede salir en remisiones de días distintos.
 *
 * Backwards-compat: `lot_ids: [uuid]` is accepted and translates to
 * items[i] = { production_lot_id, partial_ids: null }.
 *
 * After insert each touched lot is evaluated: it's marked Delivered
 * iff it was shipped whole, OR every one of its partials is now
 * either shipped or rejected. Order-completion cascade runs on the
 * lots that became Delivered.
 */
exports.handler = requireAuth(['finca', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  // Normalize input to the items[] shape.
  let items = Array.isArray(body.items) ? body.items : null;
  if (!items && Array.isArray(body.lot_ids)) {
    items = [...new Set(body.lot_ids.filter(Boolean))]
      .map((production_lot_id) => ({ production_lot_id, partial_ids: null }));
  }
  if (!items || items.length === 0) return badReq('items[] (or lot_ids[]) required', 'ITEMS_REQUIRED');

  for (const it of items) {
    if (!it.production_lot_id) return badReq('items[].production_lot_id required', 'LOT_ID_REQUIRED');
    if (it.partial_ids != null && !Array.isArray(it.partial_ids)) {
      return badReq('items[].partial_ids must be array or null', 'INVALID_PARTIAL_IDS');
    }
  }

  const shipment_code = body.shipment_code ? String(body.shipment_code).trim() : null;
  const shipment_date = body.shipment_date || bogotaToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shipment_date)) return badReq('shipment_date must be YYYY-MM-DD', 'INVALID_DATE');
  const notes = body.notes == null ? null : String(body.notes);

  // Destino + conductor (todos opcionales)
  const DESTINOS = new Set(['Vertical', 'Tribox', 'Trillanova', 'Otro']);
  const destino_kind = body.destino_kind ? String(body.destino_kind).trim() : null;
  if (destino_kind && !DESTINOS.has(destino_kind)) {
    return badReq('destino_kind must be Vertical/Tribox/Trillanova/Otro', 'INVALID_DESTINO');
  }
  const destino_other = body.destino_other == null ? null : String(body.destino_other).trim();
  if (destino_kind === 'Otro' && !destino_other) {
    return badReq('destino_other requerido cuando destino_kind=Otro', 'DESTINO_OTHER_REQUIRED');
  }
  const driver_cedula = body.driver_cedula == null ? null : String(body.driver_cedula).trim();
  const driver_placas = body.driver_placas == null ? null : String(body.driver_placas).trim().toUpperCase();
  const driver_name   = body.driver_name   == null ? null : String(body.driver_name).trim();

  const sb = getSupabase();
  const lotIds = [...new Set(items.map((i) => i.production_lot_id))];

  // Load lots with partials and existing shipment links.
  const { data: lots, error: lErr } = await sb
    .from('production_lots')
    .select(`
      id, lot_code, bache_code, status, notes,
      kg_dried_output,
      kg_green_actual, kg_green_expected,
      lot_partials ( id, parcial_letter, kg_green_yield, rejected_at )
    `)
    .in('id', lotIds);
  if (lErr) return serverErr('Lot lookup failed', lErr.message);
  if (!lots || lots.length !== lotIds.length) {
    return badReq('One or more lots not found', 'LOT_NOT_FOUND');
  }

  const notReady = lots.filter((l) => l.status !== LOT_STATUS.Ready);
  if (notReady.length > 0) {
    return conflict(
      `Lots not in Ready state: ${notReady.map((l) => l.bache_code || l.lot_code).join(', ')}`,
      'LOT_NOT_READY',
    );
  }

  // Pull existing shipment_lots rows for these lots (to detect
  // already-shipped wholes / partials and acumular kg ya despachados).
  const { data: existingLinks, error: exErr } = await sb
    .from('shipment_lots')
    .select('production_lot_id, lot_partial_id, kg_dried_shipped, kg_dried_merma, split_label')
    .in('production_lot_id', lotIds);
  if (exErr) return serverErr('Existing-link lookup failed', exErr.message);

  const partialAlreadyShipped = new Set((existingLinks || [])
    .filter((x) => x.lot_partial_id != null).map((x) => x.lot_partial_id));

  // Acumular kg seco ya despachado por lote (para despachos parciales).
  // La merma de despachos totales previos también cuenta como salida.
  const kgAlreadyShippedByLot = new Map();
  // Mayor número P ya usado en líneas de división del lote (para que
  // la numeración continúe entre despachos: P1 hoy, P2 mañana).
  const priorMaxPByLot = new Map();
  for (const x of existingLinks || []) {
    if (x.lot_partial_id != null) continue;
    const prev = kgAlreadyShippedByLot.get(x.production_lot_id) || 0;
    kgAlreadyShippedByLot.set(x.production_lot_id,
      prev + Number(x.kg_dried_shipped || 0) + Number(x.kg_dried_merma || 0));
    const m = /^P(\d+)$/.exec(x.split_label || '');
    if (m) {
      const n = Number(m[1]);
      if (n > (priorMaxPByLot.get(x.production_lot_id) || 0)) {
        priorMaxPByLot.set(x.production_lot_id, n);
      }
    }
  }
  // Kg consumido en mezclas
  const { data: blendUse } = await sb
    .from('lot_blend_components')
    .select('source_lot_id, kg_dried_used')
    .in('source_lot_id', lotIds);
  const kgInBlendsByLot = new Map();
  for (const r of blendUse || []) {
    const prev = kgInBlendsByLot.get(r.source_lot_id) || 0;
    kgInBlendsByLot.set(r.source_lot_id, prev + Number(r.kg_dried_used || 0));
  }

  // Validate every item against its lot's partials.
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const linkRows = [];   // shipment_lots inserts

  // División P1/P2: varios items whole-mode del mismo bache. Contamos
  // por lote para decidir si las líneas llevan split_label.
  const wholeItemCountByLot = new Map();
  for (const it of items) {
    const lot = lotById.get(it.production_lot_id);
    if ((lot.lot_partials || []).length === 0) {
      wholeItemCountByLot.set(lot.id, (wholeItemCountByLot.get(lot.id) || 0) + 1);
    }
  }
  const requestedSoFarByLot = new Map();  // kg (incl. merma) pedidos por líneas previas de ESTE request
  const labelSeqByLot = new Map();        // último número P asignado en este request
  const forceDeliverLots = new Set();     // close_lot: el bache cierra aunque la báscula difiera
  const pesoRealByLot = new Map();        // lot_id → { registered, real, merma } para la bitácora

  for (const it of items) {
    const lot = lotById.get(it.production_lot_id);
    const partials = lot.lot_partials || [];
    const wantPartialIds = (it.partial_ids || []).filter(Boolean);
    // Campos por bache que se aplican a cada shipment_lots de este item
    const empaque = it.empaque_interior == null || it.empaque_interior === ''
      ? null : String(it.empaque_interior);
    if (empaque != null && !['grainpro', 'bolsa'].includes(empaque)) {
      return badReq('empaque_interior must be grainpro or bolsa', 'INVALID_EMPAQUE');
    }
    const colorCinta = it.color_cinta == null || it.color_cinta === ''
      ? null : String(it.color_cinta).trim();
    if (colorCinta != null && !/^#[0-9a-fA-F]{6}$/.test(colorCinta)) {
      return badReq('color_cinta must be a #rrggbb hex', 'INVALID_COLOR');
    }
    const extras = {
      codigo_trilladora: it.codigo_trilladora == null ? null : String(it.codigo_trilladora).trim(),
      codigo_mezcla:     it.codigo_mezcla     == null ? null : String(it.codigo_mezcla).trim(),
      num_sacos:         it.num_sacos == null || it.num_sacos === '' ? null
                          : (Number.isFinite(Number(it.num_sacos)) ? Math.max(0, Math.floor(Number(it.num_sacos))) : null),
      num_lonas:         it.num_lonas == null || it.num_lonas === '' ? null
                          : (Number.isFinite(Number(it.num_lonas)) ? Math.max(0, Math.floor(Number(it.num_lonas))) : null),
      empaque_interior:  empaque,
      color_cinta:       colorCinta,
      observaciones:     it.observaciones == null ? null : String(it.observaciones).trim().slice(0, 200) || null,
      partials_merged:   it.partials_merged === false ? false : true,
    };

    if (partials.length === 0) {
      // Whole-lot mode or partial-dispatch by kg.
      if (wantPartialIds.length > 0) {
        return badReq(
          `Lote ${lot.bache_code || lot.lot_code} no tiene parciales registrados; ` +
          `omite partial_ids para despachar el lote completo`,
          'PARTIAL_IDS_NOT_ALLOWED',
        );
      }
      // Calcular kg disponible para despacho — misma fuente única
      // (_lib/lotInventory) que production-lots-list y lotAvailability.
      // Las líneas previas de ESTE request (división) también descuentan.
      const ledgerAvailable = driedLedger({
        kgDriedOutput: lot.kg_dried_output,
        blendedKg: kgInBlendsByLot.get(lot.id) || 0,
        shippedWholeKg: kgAlreadyShippedByLot.get(lot.id) || 0,
      }).available;
      const inRequest = requestedSoFarByLot.get(lot.id) || 0;
      const kgAvailable = ledgerAvailable - inRequest;

      if (kgAvailable <= 0.01) {
        if (inRequest > 0) {
          return conflict(
            `Lote ${lot.bache_code || lot.lot_code}: las líneas de la división exceden los ${round2(ledgerAvailable)} kg disponibles`,
            'EXCEEDS_AVAILABLE',
          );
        }
        return conflict(
          `Lote ${lot.bache_code || lot.lot_code} ya fue completamente despachado`,
          'LOT_ALREADY_SHIPPED',
        );
      }

      const closeLot = it.close_lot === true;
      let kgToShip = kgAvailable;
      let merma = null;
      if (it.kg_dried_to_ship != null) {
        const requested = Number(it.kg_dried_to_ship);
        if (!Number.isFinite(requested) || requested <= 0) {
          return badReq('kg_dried_to_ship must be > 0', 'INVALID_KG_SHIP');
        }
        if (closeLot) {
          // Peso real de báscula en despacho TOTAL: puede diferir del
          // registrado (humedad). Tolera hasta +3% por encima; más es
          // un error de digitación, no humedad.
          if (requested > kgAvailable * 1.03 + 0.01) {
            return conflict(
              `Lote ${lot.bache_code || lot.lot_code}: peso báscula ${requested} kg supera en más de 3% los ${round2(kgAvailable)} kg registrados`,
              'EXCEEDS_AVAILABLE',
            );
          }
          const diff = round2(kgAvailable - requested);   // >0 merma, <0 ganancia
          const pct = kgAvailable > 0 ? Math.abs(diff) / kgAvailable : 0;
          if (pct > 0.03 && body.override_peso_real !== true) {
            return conflict(
              `Lote ${lot.bache_code || lot.lot_code}: peso báscula ${requested} kg difiere ` +
              `${Math.abs(diff)} kg (${Math.round(pct * 1000) / 10}%) de los ${round2(kgAvailable)} kg registrados. ` +
              `Confirma para continuar.`,
              'PESO_REAL_CONFIRM_REQUIRED',
              { kg_registered: round2(kgAvailable), kg_real: requested, kg_diff: diff },
            );
          }
          if (Math.abs(diff) >= 0.01) merma = diff;
        } else if (requested > kgAvailable + 0.01) {
          return conflict(
            `Lote ${lot.bache_code || lot.lot_code}: solicitado ${requested} kg, disponible ${round2(kgAvailable)} kg`,
            'EXCEEDS_AVAILABLE',
          );
        }
        kgToShip = requested;
      }
      if (closeLot) {
        forceDeliverLots.add(lot.id);
        if (merma != null) {
          pesoRealByLot.set(lot.id, { registered: round2(kgAvailable), real: round2(kgToShip), merma });
        }
      }
      requestedSoFarByLot.set(lot.id, inRequest + kgToShip + (merma || 0));

      // Etiqueta de división: si el item se marcó como división
      // (split=true), si este request trae varias líneas del bache, o
      // si el bache ya tiene líneas P de despachos anteriores, la
      // línea recibe el siguiente número.
      let split_label = null;
      const priorMax = priorMaxPByLot.get(lot.id) || 0;
      if (it.split === true || (wholeItemCountByLot.get(lot.id) || 0) > 1 || priorMax > 0) {
        const seq = (labelSeqByLot.get(lot.id) || priorMax) + 1;
        labelSeqByLot.set(lot.id, seq);
        split_label = `P${seq}`;
      }

      linkRows.push({
        production_lot_id: lot.id,
        lot_partial_id: null,
        kg_dried_shipped: round2(kgToShip),
        kg_dried_merma: merma,
        split_label,
        ...extras,
      });
    } else {
      // Partial-mode required.
      if (wantPartialIds.length === 0) {
        return badReq(
          `Lote ${lot.bache_code || lot.lot_code} tiene parciales: indica partial_ids`,
          'PARTIAL_IDS_REQUIRED',
        );
      }
      const partialById = new Map(partials.map((p) => [p.id, p]));
      for (const pid of wantPartialIds) {
        const p = partialById.get(pid);
        if (!p) {
          return badReq(
            `Parcial ${pid} no pertenece al lote ${lot.bache_code || lot.lot_code}`,
            'PARTIAL_NOT_IN_LOT',
          );
        }
        if (p.rejected_at) {
          return conflict(
            `Parcial ${p.parcial_letter} del lote ${lot.bache_code || lot.lot_code} esta rechazado`,
            'PARTIAL_REJECTED',
          );
        }
        if (partialAlreadyShipped.has(p.id)) {
          return conflict(
            `Parcial ${p.parcial_letter} del lote ${lot.bache_code || lot.lot_code} ya esta en otro despacho`,
            'PARTIAL_ALREADY_SHIPPED',
          );
        }
        linkRows.push({ production_lot_id: lot.id, lot_partial_id: p.id, ...extras });
      }
    }
  }

  if (linkRows.length === 0) return badReq('No partials/lots to ship', 'NOTHING_TO_SHIP');

  // ── Insert shipment + links ────────────────────────────────────
  const { data: ship, error: sErr } = await sb
    .from('shipments').insert({
      shipment_code, shipment_date, notes,
      destino_kind, destino_other,
      driver_cedula, driver_placas, driver_name,
      created_by: session.role,
    }).select().single();
  if (sErr) {
    if (/shipments_shipment_code_key/i.test(sErr.message)) {
      return conflict('shipment_code already exists', 'DUPLICATE_CODE');
    }
    return serverErr('Failed to create shipment', sErr.message);
  }

  const insertRows = linkRows.map((r) => ({ ...r, shipment_id: ship.id }));
  const { error: linkErr } = await sb.from('shipment_lots').insert(insertRows);
  if (linkErr) {
    await sb.from('shipments').delete().eq('id', ship.id);
    return serverErr('Failed to link lots', linkErr.message);
  }

  // ── Decide which lots become Delivered ─────────────────────────
  const today = bogotaToday();
  const completions = [];
  const lotsThatGotShipped = [...new Set(linkRows.map((r) => r.production_lot_id))];

  for (const lotId of lotsThatGotShipped) {
    const lot = lotById.get(lotId);
    const partials = lot.lot_partials || [];

    let shouldDeliver = false;
    if (partials.length === 0) {
      // Despacho completo o parcial. Solo marcar Delivered si ya no
      // queda kg (la merma de peso real también cuenta como salida),
      // o si la línea cerró el bache con peso de báscula (close_lot).
      const newlySent = linkRows
        .filter((r) => r.production_lot_id === lotId && r.lot_partial_id == null)
        .reduce((s, r) => s + Number(r.kg_dried_shipped || 0) + Number(r.kg_dried_merma || 0), 0);
      const remaining = driedLedger({
        kgDriedOutput: lot.kg_dried_output,
        blendedKg: kgInBlendsByLot.get(lotId) || 0,
        shippedWholeKg: (kgAlreadyShippedByLot.get(lotId) || 0) + newlySent,
      }).available;
      shouldDeliver = remaining <= 0.01 || forceDeliverLots.has(lotId);
    } else {
      // Lot fully accounted for if every partial is shipped (in this
      // shipment or previously) or rejected.
      const newlyShippedPartialIds = new Set(
        linkRows.filter((r) => r.production_lot_id === lotId && r.lot_partial_id != null)
                .map((r) => r.lot_partial_id));
      shouldDeliver = partials.every((p) =>
        p.rejected_at != null ||
        partialAlreadyShipped.has(p.id) ||
        newlyShippedPartialIds.has(p.id));
    }

    if (!shouldDeliver) continue;

    const update = { status: LOT_STATUS.Delivered, delivered_date: today };
    // Peso real de báscula: dejar la diferencia en la bitácora.
    const pr = pesoRealByLot.get(lotId);
    if (pr) {
      const kind = pr.merma > 0 ? 'merma' : 'ganancia';
      const auditLine =
        `[Despacho total · ${actorLabel(session, body)} · ${today}] ` +
        `Peso báscula: ${pr.real} kg vs ${pr.registered} kg registrados ` +
        `(${kind} de ${Math.abs(pr.merma)} kg por humedad). Despacho ${ship.shipment_code || ship.id}.`;
      update.notes = lot.notes ? `${lot.notes}\n${auditLine}` : auditLine;
    }
    const { error: upErr } = await sb
      .from('production_lots')
      .update(update)
      .eq('id', lotId);
    if (upErr) return serverErr(`Failed to deliver lot ${lot.bache_code || lot.lot_code}`, upErr.message);

    const { data: assigns, error: aErr } = await sb
      .from('lot_order_assignments').select('demand_order_id').eq('production_lot_id', lotId);
    if (aErr) return serverErr('Assignment lookup failed', aErr.message);
    for (const a of assigns || []) {
      const result = await maybeCompleteOrder(sb, a.demand_order_id);
      if (result) completions.push(result);
    }
  }

  return ok({ shipment: ship, completions });
});

async function maybeCompleteOrder(sb, order_id) {
  const { data: order, error } = await sb
    .from('demand_orders')
    .select(`*, coffee_references(id,name)`)
    .eq('id', order_id).maybeSingle();
  if (error || !order) return null;
  if (order.status !== ORDER_STATUS.InProduction) return null;

  const { data: delivered, error: dErr } = await sb
    .from('lot_order_assignments')
    .select('kg_green_allocated, production_lots!inner(status)')
    .eq('demand_order_id', order_id)
    .eq('production_lots.status', LOT_STATUS.Delivered);
  if (dErr) return null;

  const totalDelivered = (delivered || []).reduce((s, r) => s + Number(r.kg_green_allocated || 0), 0);
  if (totalDelivered + 1e-6 < Number(order.kg_green_accepted)) return null;

  const { data: completed, error: upErr } = await sb
    .from('demand_orders').update({
      status: ORDER_STATUS.Completed,
      completed_at: new Date().toISOString(),
    }).eq('id', order_id).select().single();
  if (upErr) return null;

  const ref = order.coffee_references || { name: '' };
  const notif = await notifyOrderCompleted(completed, ref);
  return { order_id, notification: notif };
}
