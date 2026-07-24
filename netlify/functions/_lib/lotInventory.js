'use strict';

/**
 * Fuente única de verdad para la matemática de inventario de un
 * bache. Antes vivía duplicada (con las mismas fórmulas pero código
 * paralelo) en production-lots-list.js, _lib/lotAvailability.js y
 * shipments-create.js — y esa divergencia ya nos costó un bug real
 * (despacho parcial de 200 kg que dejaba al bache mostrando los 350
 * completos en Punto Final).
 *
 * Todas las funciones son PURAS: reciben filas ya cargadas, no el
 * cliente de Supabase. Los consumidores hacen sus queries y delegan
 * el cálculo aquí. Ningún redondeo interno — cada consumidor
 * redondea en su borde con round2() para no acumular error.
 *
 * Modelo:
 *
 *   SECO  (kg físicos en bodega)
 *     total      = kg_dried_output
 *     blended    = Σ kg_dried_used en mezclas donde el bache es fuente
 *     shipped    = Σ despachado en despachos CONFIRMADOS (whole/
 *                  partial-by-kg + vía parciales)
 *     held       = Σ apartado en despachos BORRADOR (preparación de
 *                  bodega): físicamente sigue en bodega pero reservado,
 *                  no disponible para planear otro despacho
 *     out        = blended + shipped
 *     available  = max(0, total − out − held)
 *
 *   VERDE (kg comerciales esperados)
 *     totalGreen   = kg_green_actual ?? kg_green_expected ?? 0
 *     greenPerDried= totalGreen / total   (0 si total = 0)
 *     greenGone    = out(seco) × greenPerDried
 *     assigned     = Σ pedidos + Σ compras directas
 *     available    = max(0, totalGreen − greenGone − assigned)
 */

// ── Sumadores de filas ───────────────────────────────────────────────

/** Σ kg_dried_used de filas de lot_blend_components (bache como fuente). */
function sumBlendedKg(blendRows) {
  return (blendRows || []).reduce((s, r) => s + Number(r.kg_dried_used || 0), 0);
}

/**
 * Σ kg seco despachado desde filas de shipment_lots.
 * Cada fila vale su kg_dried_shipped; si es un link de parcial sin
 * kg explícito (filas previas a migration 0030), cae al kg_dried
 * del parcial embebido.
 *
 * kg_dried_merma (migration 0046, despacho total con peso real de
 * báscula) también cuenta como kg que salieron de bodega: si el
 * bache tenía 350 y la báscula marcó 348, salieron 348 despachados
 * + 2 de merma → disponible 0, sin saldo fantasma.
 */
function sumShippedFromLinks(links) {
  return (links || []).reduce((s, r) => {
    const merma = Number(r.kg_dried_merma || 0);
    if (r.kg_dried_shipped != null) return s + Number(r.kg_dried_shipped) + merma;
    if (r.lot_partials && r.lot_partials.kg_dried != null) return s + Number(r.lot_partials.kg_dried) + merma;
    return s + merma;
  }, 0);
}

// Un link de despacho embebido pertenece a un borrador si su
// shipment tiene status 'draft'. Sin el embed (o sin status) se
// asume confirmado (compat con datos previos a migration 0047).
function _linkIsDraft(link) {
  return !!(link && link.shipments && link.shipments.status === 'draft');
}

/**
 * Σ kg seco despachado vía parciales en despachos CONFIRMADOS,
 * leyendo el embed lot_partials[].shipment_lots (shape de
 * production-lots-list): un parcial cuenta si tiene un link a un
 * despacho confirmado.
 */
function sumShippedFromPartials(partials) {
  return (partials || [])
    .filter((p) => (p.shipment_lots || []).some((sl) => !_linkIsDraft(sl)))
    .reduce((s, p) => s + Number(p.kg_dried || 0), 0);
}

/**
 * Σ kg seco APARTADO vía parciales en BORRADORES: un parcial cuenta
 * si su único link es a un despacho en borrador.
 */
function sumHeldFromPartials(partials) {
  return (partials || [])
    .filter((p) => {
      const links = p.shipment_lots || [];
      return links.length > 0 && links.every((sl) => _linkIsDraft(sl));
    })
    .reduce((s, p) => s + Number(p.kg_dried || 0), 0);
}

/** Σ kg_green_allocated (sirve para lot_order_assignments y lot_purchases). */
function sumAllocatedGreen(rows) {
  return (rows || []).reduce((s, r) => s + Number(r.kg_green_allocated || 0), 0);
}

// ── Ledgers ──────────────────────────────────────────────────────────

/**
 * Ledger de kg SECO del bache.
 * @param {object} p
 * @param {number|null} p.kgDriedOutput
 * @param {number} [p.blendedKg=0]
 * @param {number} [p.shippedPartialsKg=0]  despachos CONFIRMADOS vía parciales
 * @param {number} [p.shippedWholeKg=0]     despachos CONFIRMADOS whole/by-kg
 * @param {number} [p.heldKg=0]             apartado en borradores (preparación)
 */
function driedLedger({ kgDriedOutput, blendedKg = 0, shippedPartialsKg = 0, shippedWholeKg = 0, heldKg = 0 }) {
  const total = Number(kgDriedOutput || 0);
  const blended = Number(blendedKg || 0);
  const shipped = Number(shippedPartialsKg || 0) + Number(shippedWholeKg || 0);
  const held = Number(heldKg || 0);
  const out = blended + shipped;
  return {
    total,
    blended,
    shipped,
    held,
    out,
    // El apartado de borradores reduce el disponible para planear otro
    // despacho, pero NO cuenta como salida física (out).
    available: Math.max(0, total - out - held),
  };
}

/**
 * Ledger de kg VERDE del bache.
 * @param {object} p
 * @param {number|null} p.kgGreenActual
 * @param {number|null} p.kgGreenExpected
 * @param {number|null} p.kgDriedOutput
 * @param {number} [p.driedOutKg=0]          seco que ya salió (blended + shipped)
 * @param {number} [p.assignedOrdersKg=0]
 * @param {number} [p.assignedPurchasesKg=0]
 */
function greenLedger({
  kgGreenActual, kgGreenExpected, kgDriedOutput,
  driedOutKg = 0, assignedOrdersKg = 0, assignedPurchasesKg = 0,
}) {
  const totalGreen = Number(kgGreenActual ?? kgGreenExpected ?? 0);
  const totalDried = Number(kgDriedOutput ?? 0);
  const greenPerDried = totalDried > 0 ? totalGreen / totalDried : 0;
  const greenGone = Number(driedOutKg || 0) * greenPerDried;
  const assignedOrders = Number(assignedOrdersKg || 0);
  const assignedPurchases = Number(assignedPurchasesKg || 0);
  const assigned = assignedOrders + assignedPurchases;
  return {
    totalGreen,
    greenPerDried,
    greenGone,
    assignedOrders,
    assignedPurchases,
    assigned,
    available: Math.max(0, totalGreen - greenGone - assigned),
  };
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

module.exports = {
  sumBlendedKg,
  sumShippedFromLinks,
  sumShippedFromPartials,
  sumHeldFromPartials,
  sumAllocatedGreen,
  driedLedger,
  greenLedger,
  round2,
};
