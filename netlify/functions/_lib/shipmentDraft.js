'use strict';

/**
 * Aplicar cambios de LOGÍSTICA / EMPAQUE / KG a un despacho en
 * BORRADOR. Compartido por shipments-update (editar) y
 * shipments-confirm (que puede completar la info que faltaba al
 * momento de confirmar).
 *
 * NO cambia QUÉ baches entran ni sus divisiones (eso se define al
 * crear el borrador). Sí completa lo que suele ir incompleto:
 * destino, conductor, códigos, sacos/lonas, empaque, color,
 * observaciones y — para líneas whole/by-kg — los KG a despachar
 * (bodega los pesa al alistar). El kg se valida contra el disponible
 * del bache excluyendo lo apartado por este mismo borrador.
 */

const { round2 } = require('./lotInventory');

const DESTINOS = new Set(['Vertical', 'Tribox', 'Trillanova', 'Otro']);

function err(message, code) { return { ok: false, message, code }; }

// Normaliza y valida los campos de logística de UNA línea.
function normLineExtras(it) {
  const out = {};
  if ('codigo_trilladora' in it) out.codigo_trilladora = it.codigo_trilladora == null ? null : String(it.codigo_trilladora).trim();
  if ('codigo_mezcla' in it)     out.codigo_mezcla     = it.codigo_mezcla     == null ? null : String(it.codigo_mezcla).trim();
  if ('num_sacos' in it) {
    out.num_sacos = it.num_sacos == null || it.num_sacos === '' ? null
      : (Number.isFinite(Number(it.num_sacos)) ? Math.max(0, Math.floor(Number(it.num_sacos))) : null);
  }
  if ('num_lonas' in it) {
    out.num_lonas = it.num_lonas == null || it.num_lonas === '' ? null
      : (Number.isFinite(Number(it.num_lonas)) ? Math.max(0, Math.floor(Number(it.num_lonas))) : null);
  }
  if ('empaque_interior' in it) {
    const e = it.empaque_interior == null || it.empaque_interior === '' ? null : String(it.empaque_interior);
    if (e != null && !['grainpro', 'bolsa'].includes(e)) return err('empaque_interior must be grainpro or bolsa', 'INVALID_EMPAQUE');
    out.empaque_interior = e;
  }
  if ('color_cinta' in it) {
    const c = it.color_cinta == null || it.color_cinta === '' ? null : String(it.color_cinta).trim();
    if (c != null && !/^#[0-9a-fA-F]{6}$/.test(c)) return err('color_cinta must be a #rrggbb hex', 'INVALID_COLOR');
    out.color_cinta = c;
  }
  if ('observaciones' in it) {
    out.observaciones = it.observaciones == null ? null : String(it.observaciones).trim().slice(0, 200) || null;
  }
  return { ok: true, value: out };
}

/**
 * @param {object} sb
 * @param {string} shipmentId
 * @param {object} patch  { header?: {...}, lines?: [{id, ...logistics}] }
 * @returns {Promise<{ok:boolean, message?:string, code?:string}>}
 */
async function patchDraft(sb, shipmentId, patch = {}) {
  // ── Header ──────────────────────────────────────────────────────
  const h = patch.header || {};
  const headerUpdate = {};
  if ('shipment_date' in h && h.shipment_date != null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(h.shipment_date)) return err('shipment_date must be YYYY-MM-DD', 'INVALID_DATE');
    headerUpdate.shipment_date = h.shipment_date;
  }
  if ('notes' in h) headerUpdate.notes = h.notes == null ? null : String(h.notes);
  let destinoKind;
  if ('destino_kind' in h) {
    destinoKind = h.destino_kind ? String(h.destino_kind).trim() : null;
    if (destinoKind && !DESTINOS.has(destinoKind)) return err('destino_kind must be Vertical/Tribox/Trillanova/Otro', 'INVALID_DESTINO');
    headerUpdate.destino_kind = destinoKind;
  }
  if ('destino_other' in h) headerUpdate.destino_other = h.destino_other == null ? null : String(h.destino_other).trim();
  if (destinoKind === 'Otro' && !(headerUpdate.destino_other || '').trim()) {
    return err('destino_other requerido cuando destino_kind=Otro', 'DESTINO_OTHER_REQUIRED');
  }
  if ('driver_cedula' in h) headerUpdate.driver_cedula = h.driver_cedula == null ? null : String(h.driver_cedula).trim();
  if ('driver_placas' in h) headerUpdate.driver_placas = h.driver_placas == null ? null : String(h.driver_placas).trim().toUpperCase();
  if ('driver_name' in h)   headerUpdate.driver_name   = h.driver_name   == null ? null : String(h.driver_name).trim();

  if (Object.keys(headerUpdate).length > 0) {
    const { error } = await sb.from('shipments').update(headerUpdate).eq('id', shipmentId);
    if (error) return err(`Failed to update shipment: ${error.message}`, 'UPDATE_FAILED');
  }

  // ── Líneas (por shipment_lots.id, deben pertenecer al despacho) ──
  const lines = Array.isArray(patch.lines) ? patch.lines : [];
  if (lines.length > 0) {
    // Detalle de las líneas de ESTE despacho (para ownership + kg).
    const { data: own, error: ownErr } = await sb
      .from('shipment_lots')
      .select('id, production_lot_id, lot_partial_id, kg_dried_shipped, kg_dried_merma, lot_partials(kg_dried)')
      .eq('shipment_id', shipmentId);
    if (ownErr) return err(`Line lookup failed: ${ownErr.message}`, 'LINE_LOOKUP_FAILED');
    const ownById = new Map((own || []).map((r) => [r.id, r]));

    // Validar kg editados ANTES de aplicar nada (whole/by-kg solo).
    const newKgByLine = new Map();
    for (const ln of lines) {
      if (!ln || !ln.id) return err('cada línea necesita id', 'LINE_ID_REQUIRED');
      const row = ownById.get(ln.id);
      if (!row) return err(`la línea ${ln.id} no pertenece a este despacho`, 'LINE_NOT_IN_SHIPMENT');
      if (ln.kg_dried_shipped != null && ln.kg_dried_shipped !== '') {
        if (row.lot_partial_id != null) return err('el kg de un parcial no se edita aquí', 'KG_NOT_EDITABLE');
        const kg = Number(ln.kg_dried_shipped);
        if (!Number.isFinite(kg) || kg <= 0) return err('kg_dried_shipped debe ser > 0', 'INVALID_KG');
        newKgByLine.set(ln.id, round2(kg));
      }
    }

    if (newKgByLine.size > 0) {
      const kgCheck = await validateDraftKg(sb, shipmentId, own || [], newKgByLine);
      if (!kgCheck.ok) return kgCheck;
    }

    // Aplicar: primero logística, luego kg (con merma en 0 porque el
    // kg pasa a ser el valor manual).
    for (const ln of lines) {
      const norm = normLineExtras(ln);
      if (!norm.ok) return norm;
      const update = { ...norm.value };
      if (newKgByLine.has(ln.id)) {
        update.kg_dried_shipped = newKgByLine.get(ln.id);
        update.kg_dried_merma = null;
      }
      if (Object.keys(update).length === 0) continue;
      const { error } = await sb.from('shipment_lots').update(update).eq('id', ln.id);
      if (error) return err(`Failed to update line: ${error.message}`, 'LINE_UPDATE_FAILED');
    }
  }

  return { ok: true };
}

/**
 * Valida que los kg editados en un borrador no sobrepasen el
 * disponible del bache. Recalcula desde la BD: total − mezclas −
 * salidas de OTROS despachos (confirmados y borradores). El uso de
 * ESTE borrador usa el kg nuevo donde se editó y el actual en el
 * resto de sus líneas.
 */
async function validateDraftKg(sb, shipmentId, ownLines, newKgByLine) {
  const wholeOut = (r) => Number(r.kg_dried_shipped || 0) + Number(r.kg_dried_merma || 0);
  const partialKg = (r) => Number((r.lot_partials && r.lot_partials.kg_dried) || 0);

  const lotIds = [...new Set(ownLines.map((r) => r.production_lot_id))];

  const [{ data: lots }, { data: blendUse }, { data: allLinks }] = await Promise.all([
    sb.from('production_lots').select('id, bache_code, lot_code, kg_dried_output').in('id', lotIds),
    sb.from('lot_blend_components').select('source_lot_id, kg_dried_used').in('source_lot_id', lotIds),
    sb.from('shipment_lots')
      .select('shipment_id, production_lot_id, lot_partial_id, kg_dried_shipped, kg_dried_merma, lot_partials(kg_dried)')
      .in('production_lot_id', lotIds),
  ]);

  const lotById = new Map((lots || []).map((l) => [l.id, l]));
  const blendedByLot = new Map();
  for (const b of blendUse || []) {
    blendedByLot.set(b.source_lot_id, (blendedByLot.get(b.source_lot_id) || 0) + Number(b.kg_dried_used || 0));
  }
  // Salidas de OTROS despachos (excluye este borrador).
  const otherOutByLot = new Map();
  for (const x of allLinks || []) {
    if (x.shipment_id === shipmentId) continue;
    const kg = x.lot_partial_id != null ? partialKg(x) : wholeOut(x);
    otherOutByLot.set(x.production_lot_id, (otherOutByLot.get(x.production_lot_id) || 0) + kg);
  }
  // Uso de ESTE borrador (kg nuevo donde se editó, actual en el resto).
  const thisUseByLot = new Map();
  for (const r of ownLines) {
    const kg = newKgByLine.has(r.id)
      ? newKgByLine.get(r.id)
      : (r.lot_partial_id != null ? partialKg(r) : wholeOut(r));
    thisUseByLot.set(r.production_lot_id, (thisUseByLot.get(r.production_lot_id) || 0) + kg);
  }

  for (const lotId of lotIds) {
    const lot = lotById.get(lotId);
    if (!lot) continue;
    const capacity = Number(lot.kg_dried_output || 0)
      - (blendedByLot.get(lotId) || 0) - (otherOutByLot.get(lotId) || 0);
    const use = thisUseByLot.get(lotId) || 0;
    if (use > capacity + 0.01) {
      return err(
        `Lote ${lot.bache_code || lot.lot_code}: los ${round2(use)} kg del borrador superan el disponible ` +
        `(${round2(Math.max(0, capacity))} kg).`,
        'EXCEEDS_AVAILABLE',
      );
    }
  }
  return { ok: true };
}

module.exports = { patchDraft };
