'use strict';

/**
 * Aplicar cambios de LOGÍSTICA / EMPAQUE a un despacho en BORRADOR.
 * Compartido por shipments-update (editar) y shipments-confirm (que
 * puede completar la info que faltaba al momento de confirmar).
 *
 * NO cambia la estructura (qué baches / cuántos kg / divisiones): eso
 * se define al crear el borrador. Solo completa los datos que suelen
 * ir incompletos: destino, conductor, códigos de trilladora/mezcla,
 * sacos/lonas, empaque interior, color de cinta y observaciones.
 */

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
    const { data: own, error: ownErr } = await sb
      .from('shipment_lots').select('id').eq('shipment_id', shipmentId);
    if (ownErr) return err(`Line lookup failed: ${ownErr.message}`, 'LINE_LOOKUP_FAILED');
    const ownIds = new Set((own || []).map((r) => r.id));
    for (const ln of lines) {
      if (!ln || !ln.id) return err('cada línea necesita id', 'LINE_ID_REQUIRED');
      if (!ownIds.has(ln.id)) return err(`la línea ${ln.id} no pertenece a este despacho`, 'LINE_NOT_IN_SHIPMENT');
      const norm = normLineExtras(ln);
      if (!norm.ok) return norm;
      if (Object.keys(norm.value).length === 0) continue;
      const { error } = await sb.from('shipment_lots').update(norm.value).eq('id', ln.id);
      if (error) return err(`Failed to update line: ${error.message}`, 'LINE_UPDATE_FAILED');
    }
  }

  return { ok: true };
}

module.exports = { patchDraft };
