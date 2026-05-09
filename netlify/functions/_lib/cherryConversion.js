/**
 * Cherry conversion utility — Forest Production Bridge.
 *
 * Single source of truth for the kg-green ↔ kg-cherry relationship.
 * For MVP this is a flat constant (× 7.65). Flagged for future:
 * configurable per coffee_reference.
 */

'use strict';

const CHERRY_PER_GREEN = 7.65;

/**
 * @param {number} kgGreen
 * @returns {number} kg cherry, rounded to 2 decimals.
 */
function greenToCherry(kgGreen) {
  if (typeof kgGreen !== 'number' || !Number.isFinite(kgGreen) || kgGreen < 0) {
    throw new TypeError(`greenToCherry: kgGreen must be a non-negative finite number, got ${kgGreen}`);
  }
  return round2(kgGreen * CHERRY_PER_GREEN);
}

/**
 * @param {number} kgCherry
 * @returns {number} kg green expected, rounded to 2 decimals.
 */
function cherryToGreen(kgCherry) {
  if (typeof kgCherry !== 'number' || !Number.isFinite(kgCherry) || kgCherry < 0) {
    throw new TypeError(`cherryToGreen: kgCherry must be a non-negative finite number, got ${kgCherry}`);
  }
  return round2(kgCherry / CHERRY_PER_GREEN);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { CHERRY_PER_GREEN, greenToCherry, cherryToGreen };
