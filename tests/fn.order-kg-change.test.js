'use strict';

// Ajuste de cantidad de un pedido, de punta a punta:
//   · Forest lo pide   → demand-orders-request-kg-change
//   · La finca resuelve → demand-orders-resolve-kg-change
//   · La edición genérica ya no deja cambiar kg por la puerta de atrás
//
// Ver migración 0050.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const { loadHandler, setFake, postEvent, parseRes } = require('./helpers/fn-harness');

const ORDER = 'bbbbbbbb-0000-0000-0000-000000000001';

function fixture(order = {}, { deliveredKg = 0 } = {}) {
  const assignments = deliveredKg > 0 ? [{
    id: 'as1', demand_order_id: ORDER, production_lot_id: 'lot1',
    kg_green_allocated: deliveredKg,
    // El fake no resuelve embeds: la fila viene ya con la forma
    // embebida, y el filtro 'production_lots.status' se resuelve contra ella.
    production_lots: { status: 'Delivered' },
  }] : [];

  return createFakeSupabase({
    demand_orders: [{
      id: ORDER, order_code: 'PED-0001', status: 'Accepted',
      reference_id: 'ref1', process_type: 'Lavado',
      kg_green_required: 1000, kg_green_accepted: 1000,
      max_delivery_date: '2026-12-01',
      kg_green_pending_delta: null, pending_delta_reason: null,
      pending_delta_requested_at: null, pending_delta_requested_by: null,
      ...order,
    }],
    lot_order_assignments: assignments,
    coffee_references: [{ id: 'ref1', name: 'Café X', active: true }],
  });
}

const requestH = loadHandler('demand-orders-request-kg-change', fixture());
const resolveH = loadHandler('demand-orders-resolve-kg-change');
const updateH  = loadHandler('demand-orders-update');

const asForest = (body) => postEvent(body, { role: 'forest' });
const asFinca  = (body) => postEvent(body, { role: 'finca' });

const row = (fake) => fake._db.demand_orders[0];

// ── Pedir el ajuste ───────────────────────────────────────────────

test('Pending: se aplica directo, sin solicitud', async () => {
  // Nadie aceptó todavía y el pedido sigue en el inbox de la finca.
  const fake = fixture({ status: 'Pending', kg_green_accepted: null });
  setFake(fake);

  const res = parseRes(await requestH(asForest({ order_id: ORDER, delta_kg: 200 })));

  assert.equal(res.status, 200);
  assert.equal(res.body.applied, true);
  assert.equal(row(fake).kg_green_required, 1200);
  assert.equal(row(fake).kg_green_accepted, null);
  assert.equal(row(fake).kg_green_pending_delta, null);
});

test('Accepted: queda como solicitud y NO mueve los kg', async () => {
  // Esto es el corazón del arreglo: mientras la finca no confirme,
  // producción sigue trabajando contra el compromiso vigente.
  const fake = fixture();
  setFake(fake);

  const res = parseRes(await requestH(asForest({
    order_id: ORDER, delta_kg: 200, reason: 'el cliente amplió',
  })));

  assert.equal(res.status, 200);
  assert.equal(res.body.applied, false);
  assert.equal(row(fake).kg_green_required, 1000);
  assert.equal(row(fake).kg_green_accepted, 1000);
  assert.equal(Number(row(fake).kg_green_pending_delta), 200);
  assert.equal(row(fake).pending_delta_reason, 'el cliente amplió');
  assert.ok(row(fake).pending_delta_requested_at);
});

test('una solicitud nueva reemplaza la anterior sin resolver', async () => {
  const fake = fixture({ kg_green_pending_delta: 200, pending_delta_reason: 'vieja' });
  setFake(fake);

  const res = parseRes(await requestH(asForest({ order_id: ORDER, delta_kg: -100, reason: 'nueva' })));

  assert.equal(res.status, 200);
  assert.equal(Number(row(fake).kg_green_pending_delta), -100);
  assert.equal(row(fake).pending_delta_reason, 'nueva');
});

test('delta 0 → 400', async () => {
  setFake(fixture());
  const res = parseRes(await requestH(asForest({ order_id: ORDER, delta_kg: 0 })));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'DELTA_ZERO');
});

test('dejar el pedido en cero → 400, no se guarda solicitud', async () => {
  const fake = fixture();
  setFake(fake);
  const res = parseRes(await requestH(asForest({ order_id: ORDER, delta_kg: -1000 })));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'RESULT_NOT_POSITIVE');
  assert.equal(row(fake).kg_green_pending_delta, null);
});

test('bajar por debajo de lo ya despachado → 400', async () => {
  const fake = fixture({ status: 'InProduction' }, { deliveredKg: 900 });
  setFake(fake);

  const res = parseRes(await requestH(asForest({ order_id: ORDER, delta_kg: -400 })));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'BELOW_DELIVERED');
  assert.equal(row(fake).kg_green_pending_delta, null);
});

test('pedido terminal → 409', async () => {
  setFake(fixture({ status: 'Completed' }));
  const res = parseRes(await requestH(asForest({ order_id: ORDER, delta_kg: 100 })));
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'NOT_ADJUSTABLE');
});

test('la finca no puede pedir ajustes (es de Forest)', async () => {
  setFake(fixture());
  const res = parseRes(await requestH(asFinca({ order_id: ORDER, delta_kg: 100 })));
  assert.equal(res.status, 403);
});

// ── Resolver el ajuste ────────────────────────────────────────────

test('aceptar mueve required y accepted juntos y limpia la solicitud', async () => {
  const fake = fixture({ kg_green_pending_delta: 200 });
  setFake(fake);

  const res = parseRes(await resolveH(asFinca({ order_id: ORDER, accept: true })));

  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, true);
  assert.equal(row(fake).kg_green_required, 1200);
  assert.equal(row(fake).kg_green_accepted, 1200);
  assert.equal(row(fake).kg_green_pending_delta, null);
  assert.equal(row(fake).pending_delta_reason, null);
  assert.equal(row(fake).pending_delta_requested_at, null);
});

test('aceptar una reducción baja los dos', async () => {
  const fake = fixture({ kg_green_pending_delta: -300 });
  setFake(fake);

  const res = parseRes(await resolveH(asFinca({ order_id: ORDER, accept: true })));
  assert.equal(res.status, 200);
  assert.equal(row(fake).kg_green_required, 700);
  assert.equal(row(fake).kg_green_accepted, 700);
});

test('rechazar limpia la solicitud y no cambia nada más', async () => {
  const fake = fixture({ kg_green_pending_delta: 200, pending_delta_reason: 'x' });
  setFake(fake);

  const res = parseRes(await resolveH(asFinca({ order_id: ORDER, accept: false })));

  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, false);
  assert.equal(row(fake).kg_green_required, 1000);
  assert.equal(row(fake).kg_green_accepted, 1000);
  assert.equal(row(fake).kg_green_pending_delta, null);
  assert.equal(row(fake).pending_delta_reason, null);
});

test('sin solicitud pendiente → 409', async () => {
  setFake(fixture());
  const res = parseRes(await resolveH(asFinca({ order_id: ORDER, accept: true })));
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'NO_PENDING_DELTA');
});

test('falta accept → 400', async () => {
  setFake(fixture({ kg_green_pending_delta: 200 }));
  const res = parseRes(await resolveH(asFinca({ order_id: ORDER })));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'ACCEPT_REQUIRED');
});

test('Forest no puede resolver su propia solicitud', async () => {
  setFake(fixture({ kg_green_pending_delta: 200 }));
  const res = parseRes(await resolveH(asForest({ order_id: ORDER, accept: true })));
  assert.equal(res.status, 403);
});

test('si entre pedir y aceptar se despacharon kg, la solicitud se descarta', async () => {
  // Forest pidió -400 cuando no había nada despachado. Para cuando la
  // finca va a aceptar, ya salieron 900 kg: el ajuste dejó de ser válido.
  const fake = fixture({ status: 'InProduction', kg_green_pending_delta: -400 }, { deliveredKg: 900 });
  setFake(fake);

  const res = parseRes(await resolveH(asFinca({ order_id: ORDER, accept: true })));

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'DELTA_NO_LONGER_VALID');
  // Se limpia para no quedar atascada, y los kg no se tocan.
  assert.equal(row(fake).kg_green_pending_delta, null);
  assert.equal(row(fake).kg_green_required, 1000);
  assert.equal(row(fake).kg_green_accepted, 1000);
});

// ── La puerta de atrás queda cerrada ──────────────────────────────

test('la edición genérica ya no cambia kg en un pedido aceptado', async () => {
  const fake = fixture();
  setFake(fake);

  const res = parseRes(await updateH(asForest({
    order_id: ORDER, fields: { kg_green_required: 1200 },
  })));

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'KG_CHANGE_NEEDS_REQUEST');
  assert.match(res.body.error, /Ajustar kg/);
  assert.equal(row(fake).kg_green_required, 1000);
});

test('la edición genérica sí cambia kg en un pedido Pending', async () => {
  const fake = fixture({ status: 'Pending', kg_green_accepted: null });
  setFake(fake);

  const res = parseRes(await updateH(asForest({
    order_id: ORDER, fields: { kg_green_required: 1200 },
  })));

  assert.equal(res.status, 200);
  assert.equal(row(fake).kg_green_required, 1200);
});

test('editar otros campos de un pedido aceptado sigue funcionando', async () => {
  // El bloqueo es solo sobre los kg; mandar el mismo valor no molesta.
  const fake = fixture();
  setFake(fake);

  const res = parseRes(await updateH(asForest({
    order_id: ORDER,
    fields: { kg_green_required: 1000, client_name: 'Cliente Nuevo' },
  })));

  assert.equal(res.status, 200);
  assert.equal(row(fake).client_name, 'Cliente Nuevo');
  assert.equal(row(fake).kg_green_required, 1000);
});
