/**
 * Process-specific yield utilities (delivery side).
 *
 * Different processes deliver different physical forms at end-of-drying:
 *   Natural → cereza seca (whole dried cherry)
 *   Honey   → pergamino seco (dried parchment)
 *   Lavado  → pergamino seco (dried parchment)
 *
 * Conversion to green coffee:
 *   Natural: kg_green = kg_dried_output / 3.40
 *   Honey:   kg_green = kg_dried_output / 1.50
 *   Lavado:  kg_green = kg_dried_output / 1.34
 *
 * The divisors live in the DB (process_lead_times.dried_to_green_divisor)
 * and are loaded via getDriedDivisorsByProcess(). The constants below
 * mirror the seeded values for unit-test convenience and as a fallback
 * default — the DB is authoritative at runtime.
 *
 * Note: greenToCherry / cherryToGreen (× 7.65) in cherryConversion.js
 * are the demand-side forecasting utilities — used only when planning
 * how much fresh cherry an order requires.
 */

'use strict';

/** Default divisors — must be kept in sync with migration 0006_dried_yield.sql. */
const DRIED_TO_GREEN_DIVISORS = Object.freeze({
  Natural: 3.40,
  Honey:   1.50,
  Lavado:  1.34,
});

/**
 * @param {number} kgDried
 * @param {string} processType
 * @param {Record<string, number>} [divisorMap]
 * @returns {number} kg green, rounded to 2 decimals.
 */
function driedToGreen(kgDried, processType, divisorMap = DRIED_TO_GREEN_DIVISORS) {
  if (typeof kgDried !== 'number' || !Number.isFinite(kgDried) || kgDried < 0) {
    throw new TypeError(`driedToGreen: kgDried must be a non-negative finite number, got ${kgDried}`);
  }
  const divisor = divisorMap[processType];
  if (typeof divisor !== 'number' || !Number.isFinite(divisor) || divisor <= 0) {
    throw new Error(`driedToGreen: missing/invalid divisor for process_type "${processType}"`);
  }
  return round2(kgDried / divisor);
}

/**
 * @param {number} kgGreen
 * @param {string} processType
 * @param {Record<string, number>} [divisorMap]
 * @returns {number} kg dried output expected, rounded to 2 decimals.
 */
function greenToDried(kgGreen, processType, divisorMap = DRIED_TO_GREEN_DIVISORS) {
  if (typeof kgGreen !== 'number' || !Number.isFinite(kgGreen) || kgGreen < 0) {
    throw new TypeError(`greenToDried: kgGreen must be a non-negative finite number, got ${kgGreen}`);
  }
  const divisor = divisorMap[processType];
  if (typeof divisor !== 'number' || !Number.isFinite(divisor) || divisor <= 0) {
    throw new Error(`greenToDried: missing/invalid divisor for process_type "${processType}"`);
  }
  return round2(kgGreen * divisor);
}

/**
 * Spanish label for the physical dried-output form, used in UIs that
 * speak Spanish. Pure UI helper; not used in calculations.
 */
function driedOutputLabel(processType) {
  switch (processType) {
    case 'Natural': return 'Cereza seca';
    case 'Honey':   return 'Pergamino seco (honey)';
    case 'Lavado':  return 'Pergamino seco (lavado)';
    default:        return 'Producto seco';
  }
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = {
  DRIED_TO_GREEN_DIVISORS,
  driedToGreen,
  greenToDried,
  driedOutputLabel,
};
