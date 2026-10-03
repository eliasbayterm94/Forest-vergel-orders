'use strict';

/**
 * Tipos de fermentación: validación contra la tabla y el invariante
 * de "Secado directo".
 */

// El sistema ya modela "sin fermentación" con fermentation_hours = 0
// (el bache nace en Drying). Este tipo es el rótulo explícito de esa
// condición. Para que no haya baches contradictorios mantenemos:
//
//     "Secado directo" ∈ fermentation_types   ⟺   fermentation_hours = 0
//
const SECADO_DIRECTO = 'Secado directo';

/** citext en la BD: comparamos sin distinguir mayúsculas ni espacios. */
function isSecadoDirecto(name) {
  return String(name || '').trim().toLowerCase() === SECADO_DIRECTO.toLowerCase();
}

function hasSecadoDirecto(types) {
  return (types || []).some(isSecadoDirecto);
}

/**
 * Valida y normaliza nombres de tipos de fermentación contra la
 * tabla fermentation_types (sólo activos).
 */
async function validateFermentationTypes(sb, types) {
  if (!Array.isArray(types)) {
    return { ok: false, message: 'fermentation_types must be array' };
  }
  const cleaned = [...new Set(types.map((s) => String(s).trim()).filter(Boolean))];
  if (cleaned.length === 0) return { ok: true, types: cleaned };

  const { data, error } = await sb
    .from('fermentation_types').select('name').eq('active', true).in('name', cleaned);
  if (error) throw new Error(error.message);
  const validNames = new Set((data || []).map((r) => r.name));
  const invalid = cleaned.filter((n) => !validNames.has(n));
  if (invalid.length > 0) {
    return {
      ok: false,
      message: `fermentation_types: tipo(s) inválido(s) "${invalid.join(', ')}". Edita en /admin/config.`,
    };
  }
  return { ok: true, types: cleaned };
}

/**
 * Hace cumplir el invariante de arriba sobre el estado RESULTANTE.
 *
 *   types            — tipos resultantes (los del request, o los que ya tenía)
 *   fermentationHours— horas resultantes
 *   typesExplicit    — true si el request trae fermentation_types.
 *                      Distingue "el usuario lo pidió" de "ya estaba en
 *                      la fila": pedirlo con horas != 0 es un error del
 *                      usuario; heredarlo al editar solo las horas se
 *                      corrige en silencio, sin molestarlo con un 400.
 *
 * Devuelve { ok:true, types } con los tipos normalizados, o
 * { ok:false, message } si el usuario pidió algo incoherente.
 */
function reconcileSecadoDirecto(types, fermentationHours, { typesExplicit = true } = {}) {
  const list = (types || []).map((s) => String(s).trim()).filter(Boolean);
  const present = hasSecadoDirecto(list);
  const hours = Number(fermentationHours);
  const skipping = hours === 0;

  if (skipping) {
    // Horas = 0 → el tipo se marca solo. Si vino escrito con otra
    // grafía ("secado directo"), lo normalizamos al nombre canónico:
    // la columna es text[], no citext, así que la variante se
    // guardaría tal cual y la hoja del bache mostraría la grafía suelta.
    const others = list.filter((n) => !isSecadoDirecto(n));
    return { ok: true, types: [...others, SECADO_DIRECTO] };
  }

  if (!present) return { ok: true, types: list };

  // Horas != 0 con el tipo puesto: incoherente.
  if (typesExplicit) {
    return {
      ok: false,
      message: `"${SECADO_DIRECTO}" solo aplica con 0 horas de fermentación. `
             + `Pon las horas en 0, o quita ese tipo.`,
    };
  }
  // Venía de la fila y ahora hay horas reales: se quita solo.
  return { ok: true, types: list.filter((n) => !isSecadoDirecto(n)) };
}

module.exports = {
  SECADO_DIRECTO,
  isSecadoDirecto,
  hasSecadoDirecto,
  validateFermentationTypes,
  reconcileSecadoDirecto,
};
