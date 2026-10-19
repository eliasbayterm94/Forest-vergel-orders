'use strict';

// La función pura de costeo de lotes. Ver migraciones 0051 y 0052.
//
// Incluye el CASO OBLIGATORIO de negocio (T1=630, T2=6.000) y los
// casos borde que salieron del diagnóstico del modelo:
// mezclas, divisiones, salidas parciales, reproceso, lotes sin precio,
// pool regional, flotes y lotes que mezclan origen propio y comprado.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  COST_BASIS, computeLotCost, computeBlendCost, splitSnapshotCost,
} = require('../netlify/functions/_lib/lotCosting');

const PARAMS = { t1_per_kg_net: 630, t2_per_kg_own_net: 6000 };

const purchased = (kg, price, stage = 'cereza') => ({
  kg, entry_stage: stage,
  cost_basis: COST_BASIS.purchaseIdentified,
  purchase_cost_per_kg: price,
});
const pooled = (kg, avg, stage = 'cereza') => ({
  kg, entry_stage: stage,
  cost_basis: COST_BASIS.purchasePool,
  purchase_cost_per_kg: avg,
});
const own = (kg, stage = 'cereza') => ({ kg, entry_stage: stage, cost_basis: COST_BASIS.own });
const byproduct = (kg, stage = 'cereza') => ({ kg, entry_stage: stage, cost_basis: COST_BASIS.byproduct });

// ══════════════════════════════════════════════════════════════
// EL CASO OBLIGATORIO
// ══════════════════════════════════════════════════════════════

test('OBLIGATORIO · lote comprado: 1.000 kg a 3.800 → 200 kg seco = 22.150 COP/kg', () => {
  const r = computeLotCost({
    sources: [purchased(1000, 3800)],
    kgDriedOutput: 200,
    params: PARAMS,
  });
  assert.equal(r.purchase_cost_cop, 3_800_000);
  assert.equal(r.t1_cost_cop,         630_000);
  assert.equal(r.total_cost_cop,    4_430_000);
  assert.equal(r.cost_per_kg_dried,    22_150);
});

test('OBLIGATORIO · lote propio: 1.000 kg → 200 kg seco = 33.150 COP/kg', () => {
  const r = computeLotCost({
    sources: [own(1000)],
    kgDriedOutput: 200,
    params: PARAMS,
  });
  assert.equal(r.t2_cost_cop,       6_000_000);
  assert.equal(r.t1_cost_cop,         630_000);
  assert.equal(r.purchase_cost_cop,         0);
  assert.equal(r.total_cost_cop,    6_630_000);
  assert.equal(r.cost_per_kg_dried,    33_150);
});

// ══════════════════════════════════════════════════════════════
// T1 PLANO (la decisión de política)
// ══════════════════════════════════════════════════════════════

test('T1 es plano: la etapa de ingreso no cambia la tarifa por kg', () => {
  const mk = (stage) => computeLotCost({
    sources: [purchased(1000, 3800, stage)], kgDriedOutput: 200, params: PARAMS,
  });
  for (const stage of ['cereza', 'despulpado', 'seco']) {
    assert.equal(mk(stage).t1_cost_cop, 630_000, `etapa ${stage}`);
  }
});

test('el absorbido de T1 solo depende de los kg netos, no de la mezcla de etapas', () => {
  // Esta es la propiedad que hace que el cierre mensual sea
  // independiente de la mezcla: 1.000 kg son 1.000 kg.
  const a = computeLotCost({ sources: [purchased(1000, 3800, 'cereza')], kgDriedOutput: 200, params: PARAMS });
  const b = computeLotCost({
    sources: [purchased(400, 3800, 'cereza'), purchased(400, 3800, 'despulpado'), purchased(200, 3800, 'seco')],
    kgDriedOutput: 200, params: PARAMS,
  });
  assert.equal(a.t1_cost_cop, b.t1_cost_cop);
});

// ══════════════════════════════════════════════════════════════
// POOL REGIONAL
// ══════════════════════════════════════════════════════════════

test('pool: el promedio ponderado entra como precio de compra', () => {
  // 5.000 @ 3.000 + 3.500 @ 3.800 = 28.300.000 / 8.500 = 3.329,4118
  const avg = 28_300_000 / 8_500;
  const r = computeLotCost({ sources: [pooled(1000, avg)], kgDriedOutput: 200, params: PARAMS });
  assert.equal(r.cost_per_kg_dried, 19_797.0588);
  assert.equal(r.kg_input_net_purchased, 1000);
  assert.equal(r.kg_input_net_own, 0);
});

test('pool: consumir todo el pool carga exactamente lo pagado', () => {
  // La virtud contable del promedio ponderado: no sobra ni falta.
  const avg = 28_300_000 / 8_500;
  const r = computeLotCost({ sources: [pooled(8500, avg)], kgDriedOutput: 1700, params: PARAMS });
  assert.equal(r.purchase_cost_cop, 28_300_000);
});

// ══════════════════════════════════════════════════════════════
// FLOTES / SUBPRODUCTO
// ══════════════════════════════════════════════════════════════

test('flotes: costo cero y NO pagan T1 (ya está dentro del T1 del café bueno)', () => {
  const r = computeLotCost({ sources: [byproduct(80)], kgDriedOutput: 15, params: PARAMS });
  assert.equal(r.total_cost_cop, 0);
  assert.equal(r.t1_cost_cop, 0);
  assert.equal(r.cost_per_kg_dried, 0);
  assert.equal(r.kg_input_net_byproduct, 80);
});

test('flotes en un lote mixto no diluyen el costo del café bueno', () => {
  const soloBueno = computeLotCost({ sources: [purchased(920, 3097.83)], kgDriedOutput: 190, params: PARAMS });
  const conFlotes = computeLotCost({
    sources: [purchased(920, 3097.83), byproduct(80)], kgDriedOutput: 190, params: PARAMS,
  });
  // Mismo costo total: los flotes no aportan ni costo ni T1.
  assert.equal(conFlotes.total_cost_cop, soloBueno.total_cost_cop);
});

// ══════════════════════════════════════════════════════════════
// LOTE MIXTO: PROPIO + COMPRADO
// ══════════════════════════════════════════════════════════════

test('mixto: 500 propio + 500 comprado se cobran cada uno con su base', () => {
  const r = computeLotCost({
    sources: [own(500), purchased(500, 3800)], kgDriedOutput: 200, params: PARAMS,
  });
  assert.equal(r.t2_cost_cop,       500 * 6000);        // 3.000.000
  assert.equal(r.purchase_cost_cop, 500 * 3800);        // 1.900.000
  assert.equal(r.t1_cost_cop,      1000 * 630);         //   630.000
  assert.equal(r.total_cost_cop,    5_530_000);
  assert.equal(r.kg_input_net_own, 500);
  assert.equal(r.kg_input_net_purchased, 500);
  // Y el desglose por origen es el que alimenta el cierre mensual.
  assert.equal(r.t2_cost_cop + r.purchase_cost_cop + r.t1_cost_cop, r.total_cost_cop);
});

// ══════════════════════════════════════════════════════════════
// MEZCLAS: HEREDAN, NO SE RECOSTEAN
// ══════════════════════════════════════════════════════════════

test('mezcla: promedio ponderado por kg aportado', () => {
  const r = computeBlendCost({
    components: [
      { kg_dried_used: 100, cost_per_kg_dried: 22150 },
      { kg_dried_used: 300, cost_per_kg_dried: 33150 },
    ],
  });
  // (100×22.150 + 300×33.150) / 400 = 30.400
  assert.equal(r.total_cost_cop, 12_160_000);
  assert.equal(r.cost_per_kg_dried, 30_400);
  assert.equal(r.kg_dried_used, 400);
});

test('mezcla: NO se le reaplica T1 (evita el doble conteo)', () => {
  // Un solo componente: el blend debe costar exactamente lo mismo.
  const r = computeBlendCost({ components: [{ kg_dried_used: 200, cost_per_kg_dried: 22150 }] });
  assert.equal(r.cost_per_kg_dried, 22150);
  assert.equal(r.total_cost_cop, 4_430_000);
});

test('mezcla: un componente sin costear se rechaza, no se asume cero', () => {
  assert.throws(() => computeBlendCost({
    components: [{ kg_dried_used: 100, cost_per_kg_dried: 22150 },
                 { kg_dried_used: 100 }],
  }), /cost_per_kg_dried/);
});

test('mezcla con merma declarada: el costo total se conserva y sube el por-kg', () => {
  const r = computeBlendCost({
    components: [{ kg_dried_used: 200, cost_per_kg_dried: 20000 }],
    kgDriedOutput: 190,
  });
  assert.equal(r.total_cost_cop, 4_000_000);
  assert.equal(r.cost_per_kg_dried, 21_052.6316);
});

// ══════════════════════════════════════════════════════════════
// DIVISIONES: REPARTO, NO RECOSTEO
// ══════════════════════════════════════════════════════════════

test('división: el costo por kg del hijo es idéntico al del padre', () => {
  const snap = computeLotCost({ sources: [purchased(1000, 3800)], kgDriedOutput: 200, params: PARAMS });
  const { child, parentRemainder } = splitSnapshotCost({ snapshot: snap, ratio: 0.3 });

  assert.equal(child.cost_per_kg_dried, 22150);
  assert.equal(parentRemainder.cost_per_kg_dried, 22150);
  assert.equal(child.kg_dried_output, 60);
  assert.equal(parentRemainder.kg_dried_output, 140);
});

test('división: padre + hijo suman exactamente el costo original', () => {
  const snap = computeLotCost({ sources: [own(1000)], kgDriedOutput: 200, params: PARAMS });
  const { child, parentRemainder } = splitSnapshotCost({ snapshot: snap, ratio: 0.25 });
  assert.equal(child.total_cost_cop + parentRemainder.total_cost_cop, snap.total_cost_cop);
  assert.equal(child.kg_dried_output + parentRemainder.kg_dried_output, snap.kg_dried_output);
});

test('división: ratio fuera de (0,1) se rechaza', () => {
  const snap = computeLotCost({ sources: [own(1000)], kgDriedOutput: 200, params: PARAMS });
  for (const bad of [0, 1, -0.5, 1.5]) {
    assert.throws(() => splitSnapshotCost({ snapshot: snap, ratio: bad }), /ratio/);
  }
});

// ══════════════════════════════════════════════════════════════
// SALIDAS PARCIALES (sub-baches)
// ══════════════════════════════════════════════════════════════

test('salidas parciales: cada sub-bache se costea con su propia tarifa y factor', () => {
  // P1 sale en febrero con T1=630; P2 en mayo con T1=680.
  const p1 = computeLotCost({ sources: [own(600)], kgDriedOutput: 130, params: PARAMS });
  const p2 = computeLotCost({
    sources: [own(400)], kgDriedOutput: 80,
    params: { t1_per_kg_net: 680, t2_per_kg_own_net: 6200 },
  });
  assert.equal(p1.t1_cost_cop, 600 * 630);
  assert.equal(p2.t1_cost_cop, 400 * 680);
  // Y sus costos por kg difieren legítimamente: distinta tarifa, distinto factor.
  assert.notEqual(p1.cost_per_kg_dried, p2.cost_per_kg_dried);
});

// ══════════════════════════════════════════════════════════════
// FACTOR REAL
// ══════════════════════════════════════════════════════════════

test('factor real = kg seco / kg neto que entró (no es factor_rendimiento)', () => {
  const r = computeLotCost({ sources: [purchased(920, 3000)], kgDriedOutput: 190, params: PARAMS });
  assert.equal(r.real_factor_dried_per_input, 0.206522);
});

test('un factor peor encarece el kg seco con el mismo costo total', () => {
  const bueno = computeLotCost({ sources: [own(1000)], kgDriedOutput: 220, params: PARAMS });
  const malo  = computeLotCost({ sources: [own(1000)], kgDriedOutput: 180, params: PARAMS });
  assert.equal(bueno.total_cost_cop, malo.total_cost_cop);
  assert.ok(malo.cost_per_kg_dried > bueno.cost_per_kg_dried);
});

// ══════════════════════════════════════════════════════════════
// VALIDACIONES: nada se cuela a costo cero por accidente
// ══════════════════════════════════════════════════════════════

test('un lote sin fuentes no se puede costear', () => {
  assert.throws(() => computeLotCost({ sources: [], kgDriedOutput: 200, params: PARAMS }),
    /at least one input source/);
});

test('una compra sin precio se rechaza (no se asume cero)', () => {
  assert.throws(() => computeLotCost({
    sources: [{ kg: 1000, entry_stage: 'cereza', cost_basis: COST_BASIS.purchaseIdentified }],
    kgDriedOutput: 200, params: PARAMS,
  }), /purchase_cost_per_kg/);
});

test('cost_basis o etapa desconocidos se rechazan', () => {
  assert.throws(() => computeLotCost({
    sources: [{ kg: 100, entry_stage: 'cereza', cost_basis: 'regalado' }],
    kgDriedOutput: 20, params: PARAMS,
  }), /cost_basis/);
  assert.throws(() => computeLotCost({
    sources: [{ kg: 100, entry_stage: 'humedo', cost_basis: COST_BASIS.own }],
    kgDriedOutput: 20, params: PARAMS,
  }), /entry_stage/);
});

test('kg <= 0 y tarifas negativas se rechazan', () => {
  assert.throws(() => computeLotCost({ sources: [own(0)], kgDriedOutput: 20, params: PARAMS }), /kg > 0/);
  assert.throws(() => computeLotCost({
    sources: [own(100)], kgDriedOutput: 20, params: { t1_per_kg_net: -1, t2_per_kg_own_net: 6000 },
  }), /t1_per_kg_net/);
});

test('sin kg seco todavía: costo total sí, costo por kg NULL (no division por cero)', () => {
  const r = computeLotCost({ sources: [own(1000)], kgDriedOutput: 0, params: PARAMS });
  assert.equal(r.total_cost_cop, 6_630_000);
  assert.equal(r.cost_per_kg_dried, null);
});

// ══════════════════════════════════════════════════════════════
// INTEGRIDAD ARITMÉTICA
// ══════════════════════════════════════════════════════════════

test('las partes siempre suman el total (lo que la BD genera)', () => {
  const casos = [
    [purchased(1000, 3800)],
    [own(1000)],
    [own(500), purchased(500, 3800), byproduct(50)],
    [pooled(333.33, 3329.4118), own(666.67)],
  ];
  for (const sources of casos) {
    const r = computeLotCost({ sources, kgDriedOutput: 200, params: PARAMS });
    assert.equal(
      r.purchase_cost_cop + r.t2_cost_cop + r.t1_cost_cop,
      r.total_cost_cop,
      `partes != total en ${JSON.stringify(sources.map((s) => s.cost_basis))}`,
    );
  }
});

test('los kg por origen suman el total', () => {
  const r = computeLotCost({
    sources: [own(500), purchased(300, 3800), byproduct(50)],
    kgDriedOutput: 150, params: PARAMS,
  });
  assert.equal(
    r.kg_input_net_own + r.kg_input_net_purchased + r.kg_input_net_byproduct,
    r.kg_input_net_total,
  );
});

test('los decimales no arrastran error de punto flotante', () => {
  const r = computeLotCost({
    sources: [pooled(1234.56, 3097.8333)], kgDriedOutput: 256.78, params: PARAMS,
  });
  assert.equal(r.purchase_cost_cop + r.t2_cost_cop + r.t1_cost_cop, r.total_cost_cop);
  assert.ok(Number.isFinite(r.cost_per_kg_dried));
});
