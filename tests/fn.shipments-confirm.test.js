'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const { loadHandler, setFake, postEvent, parseRes } = require('./helpers/fn-harness');

const LOT = 'aaaaaaaa-0000-0000-0000-000000000001';
const SHIP = 'bbbbbbbb-0000-0000-0000-000000000001';

// Un borrador que apartó todo el bache (350 kg), listo para confirmar.
function fixture(overrides = {}) {
  const draftLine = {
    id: 'sl1', production_lot_id: LOT, lot_partial_id: null,
    kg_dried_shipped: overrides.kg ?? 350,
    kg_dried_merma: overrides.merma ?? null,
    production_lots: {
      id: LOT, bache_code: '29-1000', lot_code: 'LOT-1',
      kg_dried_output: 350, notes: overrides.notes || null,
      lot_partials: [],
    },
  };
  return createFakeSupabase({
    shipments: [{
      id: SHIP, shipment_code: 'DSP-1', status: overrides.status || 'draft',
      confirmed_at: null,
      shipment_lots: [draftLine],
    }],
    // Tabla plana para la query otherLinks (incluye la propia línea,
    // que confirm excluye por shipment_id).
    shipment_lots: [{
      id: 'sl1', shipment_id: SHIP, production_lot_id: LOT, lot_partial_id: null,
      kg_dried_shipped: overrides.kg ?? 350, kg_dried_merma: overrides.merma ?? null,
      shipments: { status: overrides.status || 'draft' },
    }],
    production_lots: [{
      id: LOT, status: 'Ready', kg_dried_output: 350,
      bache_code: '29-1000', lot_code: 'LOT-1', notes: overrides.notes || null,
    }],
    lot_blend_components: overrides.blend || [],
    lot_order_assignments: overrides.assigns || [],
    demand_orders: overrides.orders || [],
  });
}

const handler = loadHandler('shipments-confirm', fixture());

test('confirmar borrador: status confirmed + bache Delivered', async () => {
  const fake = fixture();
  setFake(fake);
  const r = parseRes(await handler(postEvent({ shipment_id: SHIP }), {}));
  assert.equal(r.status, 200);
  assert.equal(fake._db.shipments[0].status, 'confirmed');
  assert.ok(fake._db.shipments[0].confirmed_at);
  assert.equal(fake._db.production_lots[0].status, 'Delivered');
  assert.ok(fake._db.production_lots[0].delivered_date);
});

test('confirmar un despacho ya confirmado rebota NOT_A_DRAFT', async () => {
  setFake(fixture({ status: 'confirmed' }));
  const r = parseRes(await handler(postEvent({ shipment_id: SHIP }), {}));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'NOT_A_DRAFT');
});

test('confirmar despacho inexistente rebota 404', async () => {
  setFake(fixture());
  const r = parseRes(await handler(postEvent({ shipment_id: 'zzzz' }), {}));
  assert.equal(r.status, 404);
});

test('confirmar completando logística (header + línea)', async () => {
  const fake = fixture();
  setFake(fake);
  const r = parseRes(await handler(postEvent({
    shipment_id: SHIP,
    header: { destino_kind: 'Vertical', driver_name: 'Juan' },
    lines: [{ id: 'sl1', num_sacos: 5, empaque_interior: 'grainpro' }],
  }), {}));
  assert.equal(r.status, 200);
  assert.equal(fake._db.shipments[0].destino_kind, 'Vertical');
  assert.equal(fake._db.shipments[0].driver_name, 'Juan');
  assert.equal(fake._db.shipment_lots[0].num_sacos, 5);
  assert.equal(fake._db.shipment_lots[0].empaque_interior, 'grainpro');
});

test('confirmar con peso real (merma) deja nota en la bitácora del bache', async () => {
  // Borrador cerró con báscula 348 → merma 2.
  const fake = fixture({ kg: 348, merma: 2 });
  setFake(fake);
  const r = parseRes(await handler(postEvent({ shipment_id: SHIP }), {}));
  assert.equal(r.status, 200);
  assert.equal(fake._db.production_lots[0].status, 'Delivered');
  assert.match(fake._db.production_lots[0].notes || '', /merma de 2 kg/);
});

test('confirmar completa el pedido cuando todo lo asignado queda entregado', async () => {
  const ORDER = 'cccccccc-0000-0000-0000-000000000001';
  const fake = fixture({
    assigns: [{ production_lot_id: LOT, demand_order_id: ORDER, kg_green_allocated: 100,
      production_lots: { status: 'Ready' } }],
    orders: [{ id: ORDER, order_code: 'PED-1', status: 'InProduction', kg_green_accepted: 100,
      coffee_references: { id: 'r1', name: 'Ref' } }],
  });
  setFake(fake);
  const r = parseRes(await handler(postEvent({ shipment_id: SHIP }), {}));
  assert.equal(r.status, 200);
  // El bache pasó a Delivered → el pedido se completa.
  assert.equal(fake._db.production_lots[0].status, 'Delivered');
});
