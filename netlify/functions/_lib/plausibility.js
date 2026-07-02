'use strict';

/**
 * Plausibility checks para pesos al cerrar/ajustar un bache.
 * Atrapan el error de captura más caro del sistema: un typo en el
 * peso seco o el factor produce silenciosamente inventario absurdo.
 *
 * Dos niveles:
 *   HARD   — físicamente imposible → se rechaza siempre (400).
 *            El café solo PIERDE peso al secar: kg seco no puede
 *            superar el peso de entrada (tolerancia 5% por
 *            diferencias de báscula).
 *   CONFIRM— conversión resultante fuera del rango típico del
 *            stage → 409 PLAUSIBILITY_CONFIRM_REQUIRED, salvo que
 *            el request traiga override_plausibility: true. El
 *            operario con un dato raro pero real puede confirmar;
 *            el typo se atrapa.
 *
 * Rangos de conversión (kg_input_initial / kg_dried_output) por
 * stage de entrada — alineados con las alertas de /finca/analytics:
 *   cereza      2.0 – 6.0
 *   despulpado  1.5 – 3.5
 *   seco        0.95 – 1.1
 */

const CONVERSION_BANDS = {
  cereza:     { min: 2.0,  max: 6.0 },
  despulpado: { min: 1.5,  max: 3.5 },
  seco:       { min: 0.95, max: 1.1 },
};

const HARD_TOLERANCE = 1.05;   // dried puede superar input hasta 5% (báscula)

/**
 * @param {object} p
 * @param {number|null} p.kgInputInitial  peso de entrada del bache
 * @param {number}      p.kgDried         peso seco propuesto
 * @param {string|null} p.processingStage 'cereza'|'despulpado'|'seco'
 * @returns {{ hardError: string|null, confirmWarning: string|null, conversion: number|null }}
 */
function checkDriedPlausibility({ kgInputInitial, kgDried, processingStage }) {
  const initial = Number(kgInputInitial);
  const dried = Number(kgDried);
  const out = { hardError: null, confirmWarning: null, conversion: null };

  if (!Number.isFinite(dried) || dried <= 0) return out;          // lo valida el caller
  if (!Number.isFinite(initial) || initial <= 0) return out;      // sin referencia, no chequeamos

  if (dried > initial * HARD_TOLERANCE) {
    out.hardError =
      `El peso seco (${round2(dried)} kg) no puede superar el peso de entrada ` +
      `(${round2(initial)} kg): el café solo pierde peso al secar. Revisa la captura.`;
    return out;
  }

  const conversion = initial / dried;
  out.conversion = Math.round(conversion * 10000) / 10000;

  const band = CONVERSION_BANDS[processingStage] || CONVERSION_BANDS.cereza;
  if (conversion < band.min || conversion > band.max) {
    out.confirmWarning =
      `La conversión resultante (${round2(conversion)}×) está fuera del rango típico ` +
      `para stage "${processingStage || 'cereza'}" (${band.min}–${band.max}×). ` +
      `Entrada ${round2(initial)} kg → seco ${round2(dried)} kg. ` +
      `Verifica el peso antes de confirmar.`;
  }
  return out;
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

module.exports = { checkDriedPlausibility, CONVERSION_BANDS };
