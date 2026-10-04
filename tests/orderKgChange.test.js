'use strict';

// Lógica del ajuste de cantidad de un pedido (migración 0050).
//
// La regla que sostiene todo: al aceptarse, kg_green_required y
// kg_green_accepted se mueven JUNTOS. Eso es lo que mantiene viva
// chk_status_consistency (migración 0002), que exige
// accepted = required en pedidos Accepted.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateDelta, planDelta } = require('../netlify/functions/_lib/orderKgChange');

// ── validateDelta ─────────────────────────────────────────────────

test('delta acepta positivos, negativos y decimales', () => {
  assert.deepEqual(validateDelta(200),    { ok: true, value: 200 });
  assert.deepEqual(validateDelta(-150),   { ok: true, value: -150 });
  assert.deepEqual(validateDelta('75.5'), { ok: true, value: 75.5 });
});

test('delta redondea a 2 decimales, como la columna numeric(12,2)', () => {
  // Si no redondeáramos, lo validado y lo guardado podrían diferir.
  assert.deepEqual(validateDelta(10.129), { ok: true, value: 10.13 });
});

test('delta rechaza 0, vacío y no-números', () => {
  assert.equal(validateDelta(0).code, 'DELTA_ZERO');
  assert.equal(validateDelta(null).code, 'DELTA_REQUIRED');
  assert.equal(validateDelta('').code, 'DELTA_REQUIRED');
  assert.equal(validateDelta('abc').code, 'DELTA_INVALID');
  assert.equal(validateDelta(Infinity).code, 'DELTA_INVALID');
});

// ── planDelta: pedido Pending (nadie aceptó) ──────────────────────

test('Pending: solo mueve required, accepted sigue sin existir', () => {
  const order = { kg_green_required: 1000, kg_green_accepted: null, status: 'Pending' };
  const r = planDelta(order, 200, 0);
  assert.equal(r.ok, true);
  assert.deepEqual(r.next, { kg_green_required: 1200 });
  assert.equal('kg_green_accepted' in r.next, false);
});

// ── planDelta: pedido ya aceptado ─────────────────────────────────

test('Accepted: required y accepted suben juntos', () => {
  const order = { kg_green_required: 1000, kg_green_accepted: 1000, status: 'Accepted' };
  const r = planDelta(order, 200, 0);
  assert.equal(r.ok, true);
  assert.deepEqual(r.next, { kg_green_required: 1200, kg_green_accepted: 1200 });
  // La igualdad que exige chk_status_consistency se conserva.
  assert.equal(r.next.kg_green_required, r.next.kg_green_accepted);
});

test('Accepted: required y accepted bajan juntos', () => {
  const order = { kg_green_required: 1000, kg_green_accepted: 1000, status: 'Accepted' };
  const r = planDelta(order, -300, 0);
  assert.equal(r.ok, true);
  assert.deepEqual(r.next, { kg_green_required: 700, kg_green_accepted: 700 });
});

test('PartiallyAccepted: la desigualdad accepted < required se conserva', () => {
  const order = { kg_green_required: 1000, kg_green_accepted: 600, status: 'PartiallyAccepted' };
  const r = planDelta(order, 200, 0);
  assert.equal(r.ok, true);
  assert.deepEqual(r.next, { kg_green_required: 1200, kg_green_accepted: 800 });
  assert.ok(r.next.kg_green_accepted < r.next.kg_green_required);
});

// ── planDelta: topes ──────────────────────────────────────────────

test('rechaza dejar el pedido en cero o negativo', () => {
  const order = { kg_green_required: 1000, kg_green_accepted: 1000, status: 'Accepted' };
  assert.equal(planDelta(order, -1000, 0).code, 'RESULT_NOT_POSITIVE');
  assert.equal(planDelta(order, -1200, 0).code, 'RESULT_NOT_POSITIVE');
});

test('rechaza bajar por debajo de lo ya despachado', () => {
  // Ese café ya salió: el pedido no puede encogerse por detrás.
  const order = { kg_green_required: 1000, kg_green_accepted: 1000, status: 'InProduction' };
  const r = planDelta(order, -400, 900);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BELOW_DELIVERED');
  assert.match(r.message, /900/);
});

test('permite bajar justo hasta lo despachado', () => {
  const order = { kg_green_required: 1000, kg_green_accepted: 1000, status: 'InProduction' };
  const r = planDelta(order, -100, 900);
  assert.equal(r.ok, true);
  assert.equal(r.next.kg_green_accepted, 900);
});

test('subir kg nunca choca con lo despachado', () => {
  const order = { kg_green_required: 1000, kg_green_accepted: 1000, status: 'InProduction' };
  const r = planDelta(order, 500, 1000);
  assert.equal(r.ok, true);
  assert.equal(r.next.kg_green_accepted, 1500);
});

test('los decimales no arrastran error de punto flotante', () => {
  const order = { kg_green_required: 1000.1, kg_green_accepted: 1000.1, status: 'Accepted' };
  const r = planDelta(order, 0.2, 0);
  assert.equal(r.ok, true);
  assert.equal(r.next.kg_green_required, 1000.3);
  assert.equal(r.next.kg_green_accepted, 1000.3);
});
