'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  sumBlendedKg, sumShippedFromLinks, sumShippedFromPartials, sumHeldFromPartials, sumAllocatedGreen,
  driedLedger, greenLedger, round2,
} = require('../netlify/functions/_lib/lotInventory');

// ── Sumadores ────────────────────────────────────────────────────────

test('sumBlendedKg suma kg_dried_used, tolera vacío/null', () => {
  assert.equal(sumBlendedKg([{ kg_dried_used: 100 }, { kg_dried_used: 50.5 }]), 150.5);
  assert.equal(sumBlendedKg([]), 0);
  assert.equal(sumBlendedKg(null), 0);
  assert.equal(sumBlendedKg([{ kg_dried_used: null }]), 0);
});

test('sumShippedFromLinks: kg_dried_shipped manda; fallback al kg del parcial', () => {
  assert.equal(sumShippedFromLinks([
    { kg_dried_shipped: 200, lot_partial_id: null },
    { kg_dried_shipped: null, lot_partial_id: 'p1', lot_partials: { kg_dried: 150 } },
    { kg_dried_shipped: null, lot_partial_id: 'p2', lot_partials: null },   // legacy raro: 0
  ]), 350);
  assert.equal(sumShippedFromLinks([]), 0);
  // kg_dried_shipped = 0 explícito cuenta como 0, no cae al fallback
  assert.equal(sumShippedFromLinks([{ kg_dried_shipped: 0, lot_partials: { kg_dried: 99 } }]), 0);
});

test('sumShippedFromPartials: solo parciales con links', () => {
  assert.equal(sumShippedFromPartials([
    { kg_dried: 150, shipment_lots: [{ shipment_id: 's1' }] },
    { kg_dried: 50, shipment_lots: [] },            // sin despachar
    { kg_dried: 30, shipment_lots: null },          // sin embed
  ]), 150);
});

test('sumShippedFromPartials: borradores NO cuentan como despachado', () => {
  assert.equal(sumShippedFromPartials([
    { kg_dried: 150, shipment_lots: [{ shipment_id: 's1', shipments: { status: 'confirmed' } }] },
    { kg_dried: 80,  shipment_lots: [{ shipment_id: 's2', shipments: { status: 'draft' } }] },  // apartado
    { kg_dried: 40,  shipment_lots: [{ shipment_id: 's3' }] },                                   // sin status → confirmado
  ]), 190);   // 150 + 40, NO el borrador
});

test('sumHeldFromPartials: solo parciales apartados en borrador', () => {
  assert.equal(sumHeldFromPartials([
    { kg_dried: 150, shipment_lots: [{ shipment_id: 's1', shipments: { status: 'confirmed' } }] },
    { kg_dried: 80,  shipment_lots: [{ shipment_id: 's2', shipments: { status: 'draft' } }] },
    { kg_dried: 50,  shipment_lots: [] },
  ]), 80);
});

test('sumAllocatedGreen', () => {
  assert.equal(sumAllocatedGreen([{ kg_green_allocated: 300 }, { kg_green_allocated: 50 }]), 350);
  assert.equal(sumAllocatedGreen(undefined), 0);
});

// ── driedLedger ──────────────────────────────────────────────────────

test('driedLedger: escenario del bug 350/200', () => {
  const dl = driedLedger({ kgDriedOutput: 350, shippedWholeKg: 200 });
  assert.equal(dl.total, 350);
  assert.equal(dl.shipped, 200);
  assert.equal(dl.out, 200);
  assert.equal(dl.available, 150);
});

test('driedLedger: mezclas + parciales + whole combinados', () => {
  const dl = driedLedger({
    kgDriedOutput: 1000, blendedKg: 100, shippedPartialsKg: 150, shippedWholeKg: 200,
  });
  assert.equal(dl.blended, 100);
  assert.equal(dl.shipped, 350);
  assert.equal(dl.out, 450);
  assert.equal(dl.available, 550);
});

test('driedLedger clampa a 0 y tolera nulls', () => {
  assert.equal(driedLedger({ kgDriedOutput: 100, shippedWholeKg: 150 }).available, 0);
  assert.equal(driedLedger({ kgDriedOutput: null }).available, 0);
  assert.equal(driedLedger({ kgDriedOutput: 100 }).available, 100);
});

test('driedLedger: borrador aparta inventario (held) sin contar como salida', () => {
  const dl = driedLedger({ kgDriedOutput: 350, heldKg: 200 });
  assert.equal(dl.held, 200);
  assert.equal(dl.shipped, 0);
  assert.equal(dl.out, 0);            // held NO es salida física
  assert.equal(dl.available, 150);    // pero sí reduce el disponible
});

test('driedLedger: shipped + held combinados reducen el disponible', () => {
  const dl = driedLedger({ kgDriedOutput: 1000, shippedWholeKg: 300, heldKg: 200 });
  assert.equal(dl.shipped, 300);
  assert.equal(dl.held, 200);
  assert.equal(dl.out, 300);          // solo lo confirmado es salida
  assert.equal(dl.available, 500);    // 1000 - 300 - 200
});

test('driedLedger: held por defecto 0 (compat)', () => {
  const dl = driedLedger({ kgDriedOutput: 350, shippedWholeKg: 200 });
  assert.equal(dl.held, 0);
  assert.equal(dl.available, 150);
});

// ── greenLedger ──────────────────────────────────────────────────────

test('greenLedger: ratio 0.7, gone prorrateado, assigned resta', () => {
  const gl = greenLedger({
    kgGreenActual: 700, kgGreenExpected: 588, kgDriedOutput: 1000,
    driedOutKg: 450, assignedOrdersKg: 300, assignedPurchasesKg: 50,
  });
  assert.equal(gl.totalGreen, 700);
  assert.equal(gl.greenPerDried, 0.7);
  assert.equal(gl.greenGone, 315);
  assert.equal(gl.assigned, 350);
  assert.equal(gl.available, 35);
});

test('greenLedger: sin actual cae a expected; sin dried el ratio es 0', () => {
  const gl = greenLedger({ kgGreenActual: null, kgGreenExpected: 207, kgDriedOutput: null });
  assert.equal(gl.totalGreen, 207);
  assert.equal(gl.greenPerDried, 0);
  assert.equal(gl.greenGone, 0);
  assert.equal(gl.available, 207);
});

test('greenLedger clampa a 0 con sobre-compromiso', () => {
  const gl = greenLedger({
    kgGreenActual: 700, kgDriedOutput: 1000, assignedOrdersKg: 900,
  });
  assert.equal(gl.available, 0);
});

test('round2', () => {
  assert.equal(round2(4.6285714), 4.63);
  assert.equal(round2('35'), 35);
});
