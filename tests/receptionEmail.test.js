'use strict';

// El correo de recepción. Es puro (asunto + cuerpo de texto), así que
// se prueba directo sin DOM.
//
// Lo que estas pruebas protegen: que el correo refleje la entrega real
// y que NO invente ni rellene. Un correo con "Brix: —" se lee como que
// el laboratorio falló; un flote estimado que no se marque como tal se
// lee como pesado.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const MOD = pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'ui', 'reception-email.js')).href;

// La entrega real del 14-10-2026, tal como llegó por correo.
const REAL = {
  reception_code: 'REC-2026-0001', received_date: '2026-10-14',
  kg_scale_gross: 5092, sacks_count: 94, tare_per_sack_kg: 0.35,
  kg_gross: 5059.10, price_per_kg: 3900, discount_pct: 0.048,
  amount_paid_cop: 18783426.48, cherry_to_pulped_ratio: 0.544,
  brix_pct: 16, ph: 5.31, pool_key: 'Regional',
  byproduct_summary: { byproduct_pct: 0.098, kg_byproduct: 495.79, has_estimates: true },
};
const SUP = { id: 's2', name: 'Regional Manzanares', floater_franchise_pct: 0.05 };

test('correo: reproduce la entrega real del 14-10', async () => {
  const { receptionEmailDraft } = await import(MOD);
  const { subject, body } = receptionEmailDraft(REAL, SUP);

  assert.match(subject, /REC-2026-0001/);
  assert.match(subject, /14-10-2026/, 'la fecha va dd-mm-yyyy, como en el correo de la finca');
  assert.match(subject, /Regional/);

  assert.match(body, /se recepcionaron 5\.092,00 kg en 94 lonas - \(32,90 kg\)/);
  assert.match(body, /total neto de 5\.059,10 kg/);
  assert.match(body, /Prueba de flotes: 9\.8 %/);
  assert.match(body, /Brix: 16\.0 %/);
  assert.match(body, /Ph: 5\.31/);
  assert.match(body, /conversión\): 0\.544 o 54\.4 %/);
  assert.match(body, /\$3\.900 pesos el kilo puesto en Finca/);
  assert.match(body, /Valor a pagar: \$18\.783\.426/);
});

test('correo: explica el descuento con la franquicia pactada', async () => {
  const { receptionEmailDraft } = await import(MOD);
  // Ese "a partir del 5 %" es lo que hace entendible un 4.8% frente a
  // un flote del 9.8%.
  const { body } = receptionEmailDraft(REAL, SUP);
  assert.match(body, /Al 9\.8 % de flote se le realizará el descuento a partir del 5 %, para un descuento del 4\.8 %/);
});

test('correo: sin franquicia no inventa el "a partir de"', async () => {
  const { receptionEmailDraft } = await import(MOD);
  const { body } = receptionEmailDraft(REAL, { name: 'X' });
  assert.match(body, /Se aplicó un descuento del 4\.8 %/);
  assert.doesNotMatch(body, /a partir del/);
});

test('correo: marca el flote estimado y no lo hace pasar por pesado', async () => {
  const { receptionEmailDraft } = await import(MOD);
  const estimated = receptionEmailDraft(REAL, SUP).body;
  assert.match(estimated, /9\.8 % \(estimado\)/);

  const weighed = receptionEmailDraft(
    { ...REAL, byproduct_summary: { ...REAL.byproduct_summary, has_estimates: false } }, SUP,
  ).body;
  assert.match(weighed, /Prueba de flotes: 9\.8 %\n/);
  assert.doesNotMatch(weighed, /\(estimado\)/);
});

test('correo: omite los renglones sin dato en vez de poner guiones', async () => {
  const { receptionEmailDraft } = await import(MOD);
  // Entrada rápida: solo kg y precio, sin pesaje ni laboratorio.
  const { body } = receptionEmailDraft({
    reception_code: 'REC-2026-0002', received_date: '2026-10-20',
    kg_gross: 1000, price_per_kg: 3800, discount_pct: 0,
    amount_paid_cop: 3800000, pool_key: 'Regional',
  }, { name: 'Y' });

  assert.match(body, /se recepcionaron 1\.000,00 kg\./);
  assert.doesNotMatch(body, /lonas/);
  assert.doesNotMatch(body, /Brix/);
  assert.doesNotMatch(body, /Ph:/);
  assert.doesNotMatch(body, /conversión/);
  assert.doesNotMatch(body, /descuento/);
  assert.doesNotMatch(body, /—/, 'nunca un guión de relleno');
  assert.doesNotMatch(body, /undefined|NaN|null/, 'nunca un valor crudo de JS');
});

test('correo: una recepción de café propio no habla de precio', async () => {
  const { receptionEmailDraft } = await import(MOD);
  // El café de la finca no lleva precio de compra: se costea con T2.
  const { body } = receptionEmailDraft({
    reception_code: 'REC-2026-0003', received_date: '2026-10-21',
    kg_gross: 2000, discount_pct: 0,
  }, { name: 'El Vergel', kind: 'own' });
  assert.doesNotMatch(body, /negocio quedó cerrado/);
  assert.doesNotMatch(body, /Valor a pagar/);
  assert.match(body, /se recepcionaron 2\.000,00 kg\./);
});

test('correo: el mailto va sin destinatarios y bien codificado', async () => {
  const { receptionMailtoUrl } = await import(MOD);
  const url = receptionMailtoUrl(REAL, SUP);

  // Sin destinatarios a propósito: meter la lista en el frontend
  // repartiría direcciones a todo el que abra la pantalla.
  assert.ok(url.startsWith('mailto:?'), `deberia abrir sin destinatarios: ${url.slice(0, 40)}`);
  assert.doesNotMatch(url, /@/, 'ninguna dirección embebida');

  // Los saltos de línea y los acentos tienen que sobrevivir.
  assert.match(url, /%0A/, 'los saltos de línea deben ir codificados');
  // El % literal de "9.8 %" tiene que ir como %25, o el cliente de
  // correo lo lee como el inicio de un escape y rompe el cuerpo.
  assert.match(url, /%25/, 'el % literal debe ir codificado');

  // searchParams ya decodifica: volver a decodificar reventaría
  // justamente con ese % literal.
  const body = new URL(url).searchParams.get('body');
  assert.match(body, /Buenos días para todos\./);
  assert.match(body, /conversión/);
  assert.match(body, /Prueba de flotes: 9\.8 %/, 'el % debe llegar entero al cuerpo');

  // Y tiene que caber: los clientes de correo cortan los mailto largos.
  assert.ok(url.length < 2000, `el mailto es muy largo (${url.length}), se puede truncar`);
});
