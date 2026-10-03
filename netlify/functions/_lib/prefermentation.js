'use strict';

/**
 * Prefermentación: horas que el café se deja prefermentando ANTES de
 * la fermentación inicial. Ver migración 0049.
 *
 * Solo número planificado — no hay timestamp, así que no se calcula
 * real vs. plan como en fermentación.
 *
 * NULL = no se registró · 0 = no hubo prefermentación.
 */

const MAX_HOURS = 9999.99;   // tope de numeric(6,2) en la BD

/**
 * Normaliza el valor que llega por el body.
 * Devuelve { ok:true, value } (value es number|null) o { ok:false, message }.
 */
function validatePrefermentationHours(raw) {
  if (raw == null || raw === '') return { ok: true, value: null };

  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, message: 'prefermentation_hours debe ser un número' };
  }
  if (n < 0) {
    return { ok: false, message: 'prefermentation_hours debe ser >= 0' };
  }
  if (n > MAX_HOURS) {
    return { ok: false, message: `prefermentation_hours no puede exceder ${MAX_HOURS}` };
  }
  return { ok: true, value: n };
}

module.exports = { MAX_HOURS, validatePrefermentationHours };
