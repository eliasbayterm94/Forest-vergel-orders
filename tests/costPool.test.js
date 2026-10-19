'use strict';

// Pool de costo: promedio ponderado móvil para la cereza regional,
// que no se puede rastrear lote por lote. Ver _lib/costPool.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  computePoolState, quoteDraw, receptionNetKg, byproductRate, receptionAmountPaid,
} = require('../netlify/functions/_lib/costPool');

const rec = (id, date, kgNet, cop) => ({ id, received_date: date, kg_net: kgNet, amount_paid_cop: cop });
const draw = (id, at, kg) => ({ id, drawn_at: at, kg });

// ══════════════════════════════════════════════════════════════
// EL CASO DEL NEGOCIO
// ══════════════════════════════════════════════════════════════

test('el ejemplo real: Manzanares 5.000@3.000 + Huila 3.500@3.800', () => {
  const s = computePoolState({
    receptions: [
      rec('r1', '2026-10-19', 5000, 15_000_000),
      rec('r2', '2026-10-19', 3500, 13_300_000),
    ],
  });
  assert.equal(s.kg_on_hand, 8500);
  assert.equal(s.cop_on_hand, 28_300_000);
  assert.equal(s.avg_cost_per_kg, 3329.4118);
});

test('consumir TODO el pool carga exactamente lo pagado (cero desviación)', () => {
  // Esta es la virtud contable del promedio ponderado.
  const s = computePoolState({
    receptions: [
      rec('r1', '2026-10-19', 5000, 15_000_000),
      rec('r2', '2026-10-19', 3500, 13_300_000),
    ],
    draws: [draw('d1', '2026-10-19T14:00:00Z', 8500)],
  });
  assert.equal(s.total_drawn_cop, 28_300_000);
  assert.equal(s.kg_on_hand, 0);
  assert.equal(s.cop_on_hand, 0);
});

test('varios consumos parciales también cierran exacto', () => {
  const s = computePoolState({
    receptions: [rec('r1', '2026-10-19', 5000, 15_000_000), rec('r2', '2026-10-19', 3500, 13_300_000)],
    draws: [
      draw('d1', '2026-10-19T10:00:00Z', 1000),
      draw('d2', '2026-10-19T14:00:00Z', 2500),
      draw('d3', '2026-10-20T08:00:00Z', 5000),
    ],
  });
  assert.equal(s.kg_on_hand, 0);
  assert.equal(s.total_drawn_cop, 28_300_000);
  // Todos pagaron el mismo promedio: la mezcla era homogénea.
  for (const t of s.timeline.filter((x) => x.kind === 'draw')) {
    assert.equal(t.cost_per_kg, 3329.4118);
  }
});

// ══════════════════════════════════════════════════════════════
// PROMEDIO MÓVIL: el sobrante arrastra su costo
// ══════════════════════════════════════════════════════════════

test('el sobrante de ayer entra al promedio de hoy con su propio costo', () => {
  const s = computePoolState({
    receptions: [
      rec('r1', '2026-10-19', 1000, 3_000_000),   // 3.000/kg
      rec('r2', '2026-10-20', 1000, 4_000_000),   // 4.000/kg
    ],
    draws: [draw('d1', '2026-10-19T12:00:00Z', 500)],  // consume a 3.000
  });
  // Quedan 500 a 3.000 + 1.000 a 4.000 = 5.500.000 / 1.500
  assert.equal(s.kg_on_hand, 1500);
  assert.equal(s.cop_on_hand, 5_500_000);
  assert.equal(s.avg_cost_per_kg, 3666.6667);
});

test('una recepción cargada tarde NO recostea un consumo anterior', () => {
  // La propiedad que mantiene congelado lo congelado.
  const sinTardia = computePoolState({
    receptions: [rec('r1', '2026-10-19', 1000, 3_000_000)],
    draws: [draw('d1', '2026-10-19T12:00:00Z', 400)],
  });
  const conTardia = computePoolState({
    receptions: [rec('r1', '2026-10-19', 1000, 3_000_000), rec('r2', '2026-10-25', 1000, 9_000_000)],
    draws: [draw('d1', '2026-10-19T12:00:00Z', 400)],
  });
  const costoDelConsumo = (s) => s.timeline.find((x) => x.kind === 'draw').cost_per_kg;
  assert.equal(costoDelConsumo(sinTardia), 3000);
  assert.equal(costoDelConsumo(conTardia), 3000);   // intacto
  // Pero el promedio hacia adelante sí cambió.
  assert.ok(conTardia.avg_cost_per_kg > sinTardia.avg_cost_per_kg);
});

test('la recepción del día está disponible para los consumos de ese día', () => {
  const s = computePoolState({
    receptions: [rec('r1', '2026-10-19', 1000, 3_000_000)],
    draws: [draw('d1', '2026-10-19T06:00:00Z', 500)],
  });
  assert.equal(s.timeline.find((x) => x.kind === 'draw').cost_per_kg, 3000);
  assert.equal(s.is_short, false);
});

// ══════════════════════════════════════════════════════════════
// SALDO NEGATIVO: pasa con alerta, no bloquea
// ══════════════════════════════════════════════════════════════

test('consumir más de lo registrado deja saldo negativo y lo marca', () => {
  const s = computePoolState({
    receptions: [rec('r1', '2026-10-19', 1000, 3_000_000)],
    draws: [draw('d1', '2026-10-19T12:00:00Z', 1400)],
  });
  assert.equal(s.kg_on_hand, -400);
  assert.equal(s.went_negative, true);
  assert.equal(s.is_short, true);
  // Se cobró al promedio conocido, no a cero.
  assert.equal(s.timeline.find((x) => x.kind === 'draw').cost_per_kg, 3000);
});

test('un consumo contra pool vacío se cobra al último promedio conocido', () => {
  const s = computePoolState({
    receptions: [rec('r1', '2026-10-19', 1000, 3_500_000)],
    draws: [
      draw('d1', '2026-10-19T12:00:00Z', 1000),   // vacía el pool
      draw('d2', '2026-10-20T12:00:00Z', 200),    // contra pool vacío
    ],
  });
  const d2 = s.timeline.filter((x) => x.kind === 'draw')[1];
  assert.equal(d2.cost_per_kg, 3500);   // no cero
  assert.equal(d2.short, true);
});

test('cargar la recepción atrasada corrige el saldo', () => {
  const s = computePoolState({
    receptions: [rec('r1', '2026-10-19', 1000, 3_000_000), rec('r2', '2026-10-21', 600, 1_800_000)],
    draws: [draw('d1', '2026-10-20T12:00:00Z', 1400)],
  });
  assert.equal(s.kg_on_hand, 200);
  assert.equal(s.went_negative, true);   // queda el rastro de que pasó
  assert.equal(s.is_short, false);       // pero hoy ya está sano
});

// ══════════════════════════════════════════════════════════════
// NETO Y FLOTES
// ══════════════════════════════════════════════════════════════

test('neto = bruto menos subproducto separado', () => {
  assert.equal(receptionNetKg({ kg_gross: 1000 }, [{ kg: 80 }]), 920);
  assert.equal(receptionNetKg({ kg_gross: 1000 }, [{ kg: 50 }, { kg: 30 }]), 920);
  assert.equal(receptionNetKg({ kg_gross: 1000 }, []), 1000);
});

test('el costo se concentra en el neto: el café bueno sube', () => {
  const s = computePoolState({
    receptions: [rec('r1', '2026-10-19', receptionNetKg({ kg_gross: 1000 }, [{ kg: 80 }]), 2_850_000)],
  });
  // 2.850.000 / 920 neto, no / 1.000
  assert.equal(s.avg_cost_per_kg, 3097.8261);
});

test('la regla de oro: el descuento que empata = el % de flotes', () => {
  const r = byproductRate({ kg_gross: 1000, discount_pct: 0.10 }, [{ kg: 100, measurement: 'weighed' }]);
  assert.equal(r.byproduct_pct, 0.1);
  assert.equal(r.discount_pct, 0.1);
  assert.equal(r.shortfall_pct, 0);   // empató exacto

  const corto = byproductRate({ kg_gross: 1000, discount_pct: 0.05 }, [{ kg: 80, measurement: 'weighed' }]);
  assert.equal(corto.shortfall_pct, 0.03);   // faltaron 3 puntos
});

test('se marca cuando hay pesos estimados', () => {
  assert.equal(byproductRate({ kg_gross: 1000 }, [{ kg: 80, measurement: 'estimated' }]).has_estimates, true);
  assert.equal(byproductRate({ kg_gross: 1000 }, [{ kg: 80, measurement: 'weighed' }]).has_estimates, false);
});

test('una recepción cuyo neto queda en cero no entra al pool', () => {
  const s = computePoolState({ receptions: [rec('r1', '2026-10-19', 0, 500_000)] });
  assert.equal(s.kg_on_hand, 0);
  assert.equal(s.total_received_kg, 0);
});

// ══════════════════════════════════════════════════════════════
// COTIZAR UN CONSUMO
// ══════════════════════════════════════════════════════════════

test('cotizar congela el precio que se guardará en la fuente del lote', () => {
  const s = computePoolState({
    receptions: [rec('r1', '2026-10-19', 5000, 15_000_000), rec('r2', '2026-10-19', 3500, 13_300_000)],
  });
  const q = quoteDraw(s, 1000);
  assert.equal(q.cost_per_kg, 3329.4118);
  assert.equal(q.cost_cop, 3_329_411.8);
  assert.equal(q.short, false);
});

test('cotizar más de lo disponible marca short pero devuelve precio', () => {
  const s = computePoolState({ receptions: [rec('r1', '2026-10-19', 500, 1_500_000)] });
  const q = quoteDraw(s, 900);
  assert.equal(q.short, true);
  assert.equal(q.cost_per_kg, 3000);
});

test('cotizar kg inválidos se rechaza', () => {
  const s = computePoolState({ receptions: [rec('r1', '2026-10-19', 500, 1_500_000)] });
  for (const bad of [0, -5, NaN, null]) assert.throws(() => quoteDraw(s, bad), /kg/);
});

// ══════════════════════════════════════════════════════════════
// POOL VACÍO
// ══════════════════════════════════════════════════════════════

test('pool sin movimientos no truena', () => {
  const s = computePoolState({});
  assert.equal(s.kg_on_hand, 0);
  assert.equal(s.avg_cost_per_kg, 0);
  assert.equal(s.lifetime_avg_cost_per_kg, null);
  assert.deepEqual(s.timeline, []);
});

test('el promedio de vida sirve de contraste con el promedio vigente', () => {
  const s = computePoolState({
    receptions: [rec('r1', '2026-10-19', 1000, 3_000_000), rec('r2', '2026-10-20', 1000, 5_000_000)],
    draws: [draw('d1', '2026-10-19T12:00:00Z', 1000)],
  });
  assert.equal(s.lifetime_avg_cost_per_kg, 4000);   // todo lo recibido
  assert.equal(s.avg_cost_per_kg, 5000);            // lo que queda
});

// ══════════════════════════════════════════════════════════════
// RED DE SEGURIDAD DEL MONTO PAGADO
// ══════════════════════════════════════════════════════════════

test('monto pagado: usa la columna generada cuando viene', () => {
  assert.equal(receptionAmountPaid({ amount_paid_cop: 2_850_000, kg_gross: 1000, price_per_kg: 3000 }),
    2_850_000);
});

test('monto pagado: lo deriva si la columna generada no vino', () => {
  // El modo de falla importa: un monto ausente costearía el café a
  // CERO y lo haría ver gratis.
  assert.equal(receptionAmountPaid({ kg_gross: 1000, price_per_kg: 3000, discount_pct: 0.05 }),
    2_850_000);
  assert.equal(receptionAmountPaid({ kg_gross: 1000, price_per_kg: 3000 }), 3_000_000);
});

test('monto pagado: NULL solo cuando no hay precio (café propio)', () => {
  assert.equal(receptionAmountPaid({ kg_gross: 1000, price_per_kg: null }), null);
});

test('monto pagado: un cero explícito se respeta, no se re-deriva', () => {
  assert.equal(receptionAmountPaid({ amount_paid_cop: 0, kg_gross: 1000, price_per_kg: 3000 }), 0);
});
