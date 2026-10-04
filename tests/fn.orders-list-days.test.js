'use strict';

// demand-orders-list expone los días contra los dos plazos del pedido.
//
// El número ya se calculaba para decidir el color del pill, pero se
// descartaba y solo salía el bucket ('past'/'red'/...). Forest y la
// finca necesitaban el dato crudo para priorizar.
//
//   days_to_delivery     → la promesa al cliente
//   days_to_drying_start → el disparo operativo (vence antes)
//
// Positivo = faltan tantos días · 0 = es hoy · negativo = vencido.

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');

// Los lead-times viven en supabase.js y se consultan por funciones que
// el endpoint desestructura en el require, así que hay que stubbearlas
// ANTES de cargarlo. El harness hace lo mismo con los divisores.
const FN_DIR = path.join(__dirname, '..', 'netlify', 'functions');
const supaModule = require(path.join(FN_DIR, '_lib', 'supabase'));
supaModule.getDryingDaysByProcess    = async () => ({ Natural: 12, Honey: 8, Lavado: 8 });
supaModule.getProcessingDaysByProcess = async () => ({ Natural: 6, Honey: 6, Lavado: 6 });

const { loadHandler, setFake, postEvent, parseRes } = require('./helpers/fn-harness');
const { bogotaToday, addDays } = require(path.join(FN_DIR, '_lib', 'bogotaTime'));

const listH = loadHandler('demand-orders-list');

function fixtureWithDelivery(maxDeliveryDate, extra = {}) {
  return createFakeSupabase({
    demand_orders: [{
      id: 'o1', order_code: 'PED-0001', reference_id: 'ref1',
      status: 'Accepted', process_type: 'Lavado',
      kg_green_required: 1000, kg_green_accepted: 1000,
      max_delivery_date: maxDeliveryDate,
      kg_green_pending_delta: null,
      coffee_references: { id: 'ref1', name: 'Café X' },
      demand_order_varieties: [],
      ...extra,
    }],
  });
}

const getEvent = () => ({
  httpMethod: 'GET',
  headers: postEvent(null, { role: 'forest' }).headers,
  queryStringParameters: {},
});

async function firstOrder(fake) {
  setFake(fake);
  const res = parseRes(await listH(getEvent()));
  assert.equal(res.status, 200, `esperaba 200, vino ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.orders[0];
}

test('entrega futura → días positivos', async () => {
  const o = await firstOrder(fixtureWithDelivery(addDays(bogotaToday(), 20)));
  assert.equal(o.days_to_delivery, 20);
});

test('entrega hoy → 0', async () => {
  const o = await firstOrder(fixtureWithDelivery(bogotaToday()));
  assert.equal(o.days_to_delivery, 0);
});

test('entrega pasada → días negativos', async () => {
  const o = await firstOrder(fixtureWithDelivery(addDays(bogotaToday(), -5)));
  assert.equal(o.days_to_delivery, -5);
});

test('el plazo de secado vence antes que la entrega', async () => {
  // Lavado = 8 días de secado + 6 de proceso: hay que empezar a secar
  // bastante antes de la fecha de entrega.
  const o = await firstOrder(fixtureWithDelivery(addDays(bogotaToday(), 30)));
  assert.equal(typeof o.days_to_drying_start, 'number');
  assert.ok(o.days_to_drying_start < o.days_to_delivery,
    `secado (${o.days_to_drying_start}) debería vencer antes que entrega (${o.days_to_delivery})`);
});

test('el bucket de urgencia sigue saliendo, además del número', async () => {
  const o = await firstOrder(fixtureWithDelivery(addDays(bogotaToday(), 3)));
  assert.equal(o.days_to_delivery, 3);
  assert.equal(o.delivery_urgency, 'red');
});

test('expone el ajuste de kg pendiente para que la finca lo vea', async () => {
  const o = await firstOrder(fixtureWithDelivery(addDays(bogotaToday(), 20), {
    kg_green_pending_delta: 200,
    pending_delta_reason: 'el cliente amplió',
  }));
  assert.equal(Number(o.kg_green_pending_delta), 200);
  assert.equal(o.pending_delta_reason, 'el cliente amplió');
});
