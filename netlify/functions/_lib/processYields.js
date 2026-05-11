/**
 * Process-specific yield utilities.
 *
 * Two distinct purposes:
 *
 *  A) INPUT-STAGE divisors — used at lot creation when the operator
 *     reports how much they received at one of three processing stages:
 *
 *       cereza      — fresh whole cherry              kg / 7.65 = green
 *       despulpado  — wet depulped (mucilage / wet)    kg / 4.20 = green
 *       seco        — dried product (any process)      kg / 1.34 = green
 *
 *     These are universal accounting factors per the operations team.
 *
 *  B) DRIED-TO-GREEN per-process divisors — used at lot DELIVERY when
 *     measured kg_dried_output is converted to actual green yield. These
 *     are loaded from process_lead_times.dried_to_green_divisor and are
 *     more accurate per process:
 *
 *       Natural (cereza seca)       kg / 3.40 = green
 *       Honey   (pergamino seco)    kg / 1.50 = green
 *       Lavado  (pergamino seco)    kg / 1.34 = green
 *
 * (A) and (B) coexist intentionally. (A) is a standard accounting view
 * regardless of process; (B) is the precise yield measurement at end of
 * drying. In practice the kg_dried_output → kg_green_actual conversion
 * at delivery is the authoritative number.
 *
 * The demand-side cherry conversion (× 7.65) lives in
 * cherryConversion.js and is the single source of truth for forecasting
 * how much fresh cherry an order requires.
 */

'use strict';

// ── A) Input-stage divisors ────────────────────────────────────────
const INPUT_STAGE_DIVISORS = Object.freeze({
  cereza:     7.65,
  despulpado: 4.20,
  seco:       1.34,
});

const INPUT_STAGE_LABELS = Object.freeze({
  cereza:     'Cereza fresca',
  despulpado: 'Despulpado (wet)',
  seco:       'Seco',
});

/**
 * Convert a weight at any input stage to its green-coffee equivalent.
 * @param {number} kgInput
 * @param {'cereza'|'despulpado'|'seco'} stage
 * @returns {number} kg green, rounded to 2 decimals.
 */
function inputToGreen(kgInput, stage) {
  if (typeof kgInput !== 'number' || !Number.isFinite(kgInput) || kgInput < 0) {
    throw new TypeError(`inputToGreen: kgInput must be a non-negative finite number, got ${kgInput}`);
  }
  const divisor = INPUT_STAGE_DIVISORS[stage];
  if (!divisor) {
    throw new Error(`inputToGreen: unknown processing stage "${stage}"`);
  }
  return round2(kgInput / divisor);
}

function inputStageLabel(stage) { return INPUT_STAGE_LABELS[stage] || stage; }

// ── Per-lot yield factor (Colombian "factor de rendimiento") ────────
//
// Per-lot factor expressing how many kg of dried parchment are needed
// to produce one 70-kg saco of green. Replaces the per-process divisor
// at the Ready transition — every lot gets its own factor measured at
// the dry-mill.
//
//   kg_green = (kg_dried_output / factor_rendimiento) * KG_PER_SACO
//
// Example: 1000 kg seco / 145 * 70 = 482.76 kg verde.
const KG_PER_SACO = 70;

/**
 * @param {number} kgDried
 * @param {number} factor   factor de rendimiento (>0)
 * @returns {number} kg green, rounded to nearest integer (half-up).
 *
 * El resultado es un entero porque operativamente decimales no
 * aportan utilidad y la columna lot_partials.kg_green_yield tambien
 * es numeric(12,0) tras migration 0020.
 */
function factorYield(kgDried, factor) {
  if (typeof kgDried !== 'number' || !Number.isFinite(kgDried) || kgDried < 0) {
    throw new TypeError(`factorYield: kgDried must be a non-negative finite number, got ${kgDried}`);
  }
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0) {
    throw new Error(`factorYield: factor must be a positive number, got ${factor}`);
  }
  return Math.round((kgDried / factor) * KG_PER_SACO);
}

// ── B) Dried-to-green per-process divisors ──────────────────────────
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
  INPUT_STAGE_DIVISORS,
  INPUT_STAGE_LABELS,
  inputToGreen,
  inputStageLabel,
  KG_PER_SACO,
  factorYield,
  DRIED_TO_GREEN_DIVISORS,
  driedToGreen,
  greenToDried,
  driedOutputLabel,
};
