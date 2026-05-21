'use strict';

/**
 * Motor de planeación semanal · MVP v2
 *
 * Modelo operativo: lo que llega un día se procesa ese día. Cada
 * llegada (cereza/despulpado/seco) se reparte entre los pedidos
 * elegibles ordenados por urgencia. Si sobra después de cubrir
 * pedidos, el remanente del día queda como bache "a designar" ese
 * mismo día.
 *
 * Reglas de proceso:
 *   · Natural acepta solo cereza.
 *   · Honey/Lavado aceptan cereza, despulpado y seco. En un día
 *     dado, el seco se asigna primero, luego despulpado, luego
 *     cereza (el seco está más cerca del verde y libera kg verde
 *     más rápido).
 *
 * Prioridad por día:
 *   · Para cereza: Natural primero (porque H/L también puede
 *     consumir despulpado/seco), luego H/L. Tie-break por
 *     max_delivery_date.
 *   · Para despulpado y seco: H/L por urgencia.
 *
 * Conversión input → verde (divisores):
 *   cereza ÷ 7.65 · despulpado ÷ 4.20 · seco ÷ 1.34.
 *
 * Capacidades simultáneas:
 *   Fermentación 25.000 · Mecánico 5.000 · Patios Natural 20.000 ·
 *   Patios H/L 40.000 kg.
 */

const INPUT_TO_GREEN = { cereza: 7.65, despulpado: 4.20, seco: 1.34 };

const CAPACITY = {
  fermentation_kg: 25000,
  mecanico_kg: 5000,
  patios_natural_kg: 20000,
  patios_hl_kg: 40000,
};

const DRYING_DAYS = {
  mecanico:    { Natural: 5, Honey: 3, Lavado: 3 },
  patios:      { Natural: 10, Honey: 6, Lavado: 6 },
};

// Fermentación por proceso (límite superior conservador, ver ops 2026-05).
const FERM_DAYS = { Natural: 2, Honey: 3, Lavado: 3 };

// Reposo post-secado antes de pasar a bodega/trilla.
const RESTING_DAYS = 7;

// Horizonte de simulación: lo suficiente para que un bache iniciado
// el día 6 de la semana termine ferm + secado + reposo (≈ 20 días en
// el peor caso). 28 días cubre con margen.
const SIMULATION_HORIZON_DAYS = 28;

function round2(n) { return Math.round(n * 100) / 100; }

function isoDays(weekStartDate) {
  const out = [];
  const d = new Date(weekStartDate + 'T00:00:00Z');
  for (let i = 0; i < 7; i++) {
    const day = new Date(d.getTime() + i * 86400000);
    out.push(day.toISOString().slice(0, 10));
  }
  return out;
}

function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dateRangeInclusive(fromISO, toISO) {
  const out = [];
  let cur = fromISO;
  while (cur <= toISO) { out.push(cur); cur = addDaysISO(cur, 1); }
  return out;
}

// Snapshot inicial de planta para los semáforos de capacidad.
function plantSnapshot(lots) {
  let ferm = 0, mec = 0, patN = 0, patHL = 0;
  for (const l of lots || []) {
    const kgGreen = Number(l.kg_green_expected || l.kg_green_actual || 0);
    if (l.status === 'InFermentation') ferm += kgGreen;
    if (l.status === 'Drying') {
      const locs = Array.isArray(l.drying_locations) ? l.drying_locations : [];
      const goesPatios   = locs.includes('Patio');
      const goesMecanico = locs.includes('Silos');
      if (goesMecanico && !goesPatios) mec += kgGreen;
      else if (l.process_type === 'Natural') patN += kgGreen;
      else patHL += kgGreen;
    }
  }
  return {
    fermentation_used_kg: round2(ferm),
    mecanico_used_kg:     round2(mec),
    patios_natural_used_kg: round2(patN),
    patios_hl_used_kg:    round2(patHL),
  };
}

// Procesos elegibles para consumir cada stage de input.
function eligibleProcessesFor(stage) {
  if (stage === 'cereza') return ['Natural', 'Honey', 'Lavado'];
  return ['Honey', 'Lavado'];
}

// Orden de prioridad: para cereza, Natural primero (los H/L pueden
// usar otras llegadas). Luego siempre por fecha de entrega asc.
function orderPriorityComparator(stage) {
  return (a, b) => {
    if (stage === 'cereza') {
      const pa = a.process_type === 'Natural' ? 0 : 1;
      const pb = b.process_type === 'Natural' ? 0 : 1;
      if (pa !== pb) return pa - pb;
    }
    const da = a.max_delivery_date || '9999-99-99';
    const db = b.max_delivery_date || '9999-99-99';
    if (da !== db) return da.localeCompare(db);
    const sa = a.status === 'InProduction' ? 0 : 1;
    const sb = b.status === 'InProduction' ? 0 : 1;
    return sa - sb;
  };
}

// Default de proceso para baches "a designar" según stage.
function defaultProcessFor(stage) {
  return stage === 'seco' ? 'Lavado' : 'Honey';
}

// Decisión de secadero: baches chicos al mecánico, grandes a patios.
function chooseDryer(kgGreen) {
  return kgGreen < 2000 ? 'Mecánico' : 'Patios';
}

// ── Algoritmo principal ────────────────────────────────────────────
function computePlan({ weekStartDate, dayInputs, orders, lots }) {
  const days = isoDays(weekStartDate);
  const snapshot = plantSnapshot(lots);

  // Trabajamos sobre copias mutables de los remaining de cada pedido.
  const workingOrders = (orders || [])
    .filter((o) => Number(o.remaining_kg || 0) > 0.01)
    .map((o) => ({ ...o, _remaining_green: Number(o.remaining_kg) }));

  const alerts = [];
  const plan = [];

  // Totales para reporte
  const totals = { cereza: 0, despulpado: 0, seco: 0 };
  const consumedByOrder = new Map();   // order_id → kg verde cubierto
  let totalDemandKg = 0;
  for (const o of workingOrders) totalDemandKg += Number(o.remaining_kg || 0);

  // ── Iterar día por día ───────────────────────────────────────────
  for (const date of days) {
    const arr = dayInputs[date] || {};
    const arrivals = {
      cereza:     Math.max(0, Number(arr.cereza     || 0)),
      despulpado: Math.max(0, Number(arr.despulpado || 0)),
      seco:       Math.max(0, Number(arr.seco       || 0)),
    };
    totals.cereza     += arrivals.cereza;
    totals.despulpado += arrivals.despulpado;
    totals.seco       += arrivals.seco;

    const dayEntry = {
      date,
      arrivals: { ...arrivals },
      batches: [],
      ferm_used: 0,
    };

    // Asignar cada stage que llegó hoy. Orden seco → despulpado →
    // cereza: dejamos la cereza al final para que H/L primero
    // consuma seco/despulpado y la cereza quede preferentemente para
    // los Naturales.
    for (const stage of ['seco', 'despulpado', 'cereza']) {
      let available = arrivals[stage];
      if (available <= 0.01) continue;

      const candidates = workingOrders
        .filter((o) => o._remaining_green > 0.01
          && eligibleProcessesFor(stage).includes(o.process_type))
        .sort(orderPriorityComparator(stage));

      for (const order of candidates) {
        if (available <= 0.01) break;
        const inputNeeded = order._remaining_green * INPUT_TO_GREEN[stage];
        const take = Math.min(available, inputNeeded);
        const kgGreen = take / INPUT_TO_GREEN[stage];

        dayEntry.batches.push({
          kind: 'order',
          order_id: order.id,
          order_code: order.order_code,
          reference_name: order.reference_name,
          client_name: order.client_name,
          max_delivery_date: order.max_delivery_date,
          process_type: order.process_type,
          stage_input: stage,
          kg_input: round2(take),
          kg_green: round2(kgGreen),
          target_dryer: chooseDryer(kgGreen),
        });

        available -= take;
        order._remaining_green -= kgGreen;
        dayEntry.ferm_used += kgGreen;
        consumedByOrder.set(order.id, (consumedByOrder.get(order.id) || 0) + kgGreen);
      }

      // Excedente del día → bache "a designar" ese mismo día.
      if (available > 0.01) {
        const kgGreen = available / INPUT_TO_GREEN[stage];
        const process = defaultProcessFor(stage);
        dayEntry.batches.push({
          kind: 'excess',
          order_id: null,
          order_code: null,
          reference_name: 'A designar',
          client_name: null,
          max_delivery_date: null,
          process_type: process,
          stage_input: stage,
          kg_input: round2(available),
          kg_green: round2(kgGreen),
          target_dryer: chooseDryer(kgGreen),
        });
        dayEntry.ferm_used += kgGreen;
      }
    }

    dayEntry.ferm_used = round2(dayEntry.ferm_used);
    plan.push(dayEntry);
  }

  // ── Alertas ─────────────────────────────────────────────────────

  // 1. Pedidos con cobertura parcial al final de la semana
  for (const o of workingOrders) {
    if (o._remaining_green > 0.01) {
      alerts.push({
        kind: 'partial_coverage',
        order_id: o.id,
        message: `Pedido ${o.order_code} queda con cobertura parcial — falta ${round2(o._remaining_green)} kg verde para la entrega del ${o.max_delivery_date}.`,
      });
    }
  }

  // 2. Cuellos de botella — simulador de flujo (real + planeado)
  const flow = simulateFlow({ weekStartDate, planDays: plan, lots });
  for (const b of flow.bottlenecks) {
    alerts.push({
      kind: 'capacity_exceeded',
      day: b.day,
      resource: b.resource,
      message: `${b.label}: ${b.kg} / ${b.limit} kg el ${b.day} (excede ${b.over_kg} kg).`,
    });
  }

  // 3. Excedente sin pedido asociado
  let excessKg = 0;
  for (const d of plan) {
    for (const b of d.batches) if (b.kind === 'excess') excessKg += b.kg_input;
  }
  if (excessKg > 0.01) {
    alerts.push({
      kind: 'excess',
      message: `${round2(excessKg)} kg de input quedan sin pedido — programados como "a designar". Asignar manualmente al confirmar.`,
    });
  }

  // ── Factibilidad: % kg verde cubierto vs demandado ──
  let coveredKg = 0;
  for (const v of consumedByOrder.values()) coveredKg += v;
  const feasibility_pct = totalDemandKg > 0
    ? round2((coveredKg / totalDemandKg) * 100)
    : 100;

  return {
    plan,
    alerts,
    feasibility_pct,
    snapshot,
    totals,
    coverage: { covered_kg: round2(coveredKg), demand_kg: round2(totalDemandKg) },
    flow,
  };
}

// ── Simulador de flujo ─────────────────────────────────────────────
//
// Modela la trayectoria de cada bache (real + planeado) por las
// etapas: Fermentación → Secado (Mecánico ó Patios). El reposo y la
// trilla no se modelan como cuello de botella (capacidad alta).
//
// · Para baches REALES en planta (InFermentation / Drying) asumimos
//   ocupación constante durante la semana — no sabemos su día de
//   inicio exacto. Modelo conservador (peor caso de capacidad).
// · Para baches PLANEADOS arrancan el día que les asigna el plan y
//   recorren ferm → secado con tiempos por proceso/secadero.
//
// Output:
//   { gantt: [...], daily_occupancy: {date: {...}}, bottlenecks: [...] }

// Devuelve las etapas que recorrerá un bache planeado, desde su día
// de entrada. Cada etapa lleva su `category` (fermentation/drying/
// resting/ready) para el balance, y su `resource` para el heatmap de
// capacidad. `kg` es la masa física que ocupa (input bruto), no kg
// verde — porque las capacidades de planta están definidas en kg
// físicos del momento.
function timelineFor(batch, startDate) {
  const stages = [];
  let cursor = startDate;
  const stage_input = batch.stage_input;
  const proc = batch.process_type;
  const kg = batch.kg_input;

  // 1. Fermentación (solo cereza; despulpado/seco entran ya post-ferm).
  const fermDays = stage_input === 'cereza' ? (FERM_DAYS[proc] || 0) : 0;
  if (fermDays > 0) {
    const end = addDaysISO(cursor, fermDays - 1);
    stages.push({ stage: 'Fermentación', category: 'fermentation',
      resource: 'fermentation', from: cursor, to: end, kg });
    cursor = addDaysISO(end, 1);
  }

  // 2. Secado (no aplica si entró ya seco).
  if (stage_input !== 'seco') {
    const dryer = batch.target_dryer === 'Mecánico' ? 'mecanico' : 'patios';
    const dryingDays = (DRYING_DAYS[dryer] && DRYING_DAYS[dryer][proc]) || 0;
    let resource = null, stageLabel = null;
    if (dryer === 'mecanico') { resource = 'mecanico'; stageLabel = 'Mecánico'; }
    else if (proc === 'Natural') { resource = 'patios_natural'; stageLabel = 'Patios N'; }
    else { resource = 'patios_hl'; stageLabel = 'Patios H/L'; }
    if (dryingDays > 0 && resource) {
      const end = addDaysISO(cursor, dryingDays - 1);
      stages.push({ stage: stageLabel, category: 'drying',
        resource, from: cursor, to: end, kg });
      cursor = addDaysISO(end, 1);
    }
  }

  // 3. Reposo (~7 días post-secado antes de pasar a trilla/bodega).
  if (RESTING_DAYS > 0) {
    const end = addDaysISO(cursor, RESTING_DAYS - 1);
    stages.push({ stage: 'Reposo', category: 'resting',
      resource: 'resting', from: cursor, to: end, kg });
    cursor = addDaysISO(end, 1);
  }

  // 4. Listo para bodega (un día marcador — del 'in' del día sale a bodega).
  stages.push({ stage: 'Listo', category: 'ready',
    resource: 'ready', from: cursor, to: cursor, kg });

  return stages;
}

function simulateFlow({ weekStartDate, planDays, lots }) {
  const weekDays = isoDays(weekStartDate);
  const horizon = [];
  for (let i = 0; i < SIMULATION_HORIZON_DAYS; i++) {
    horizon.push(addDaysISO(weekStartDate, i));
  }
  const occByDay = {};
  for (const d of horizon) {
    occByDay[d] = { fermentation: 0, mecanico: 0, patios_natural: 0, patios_hl: 0,
                    resting: 0, ready: 0 };
  }
  // Balance por etapa: entradas/salidas por día
  const stageBalance = {};
  for (const d of weekDays) {
    stageBalance[d] = {
      fermentation: { in: 0, out: 0 },
      drying:       { in: 0, out: 0 },
      resting:      { in: 0, out: 0 },
      ready:        { in: 0, out: 0 }, // out = pasa a bodega
    };
  }

  const gantt = [];

  // ── Baches reales (no Delivered) ───────────────────────────────
  // Ocupación constante esta semana (no conocemos día de inicio
  // exacto). Usamos kg_input_initial (peso bruto inicial). Si no
  // existe, fallback a kg_cherry_input o kg_green_expected ×7.65 como
  // último recurso.
  for (const l of lots || []) {
    const kg = Number(l.kg_input_initial || l.kg_cherry_input
      || (Number(l.kg_green_expected || l.kg_green_actual || 0) * 7.65) || 0);
    if (kg <= 0) continue;
    const label = l.bache_code || l.lot_code || 'Bache sin código';
    if (l.status === 'InFermentation') {
      for (const d of weekDays) occByDay[d].fermentation += kg;
      gantt.push({
        kind: 'real', label, process: l.process_type,
        kg_input: round2(kg),
        stages: [{ stage: 'Fermentación', category: 'fermentation',
          resource: 'fermentation', from: weekDays[0], to: weekDays[6], kg }],
      });
    } else if (l.status === 'Drying') {
      const locs = Array.isArray(l.drying_locations) ? l.drying_locations : [];
      const useMecanico = locs.includes('Silos') && !locs.includes('Patio');
      let resource, stageLabel;
      if (useMecanico) { resource = 'mecanico'; stageLabel = 'Mecánico'; }
      else if (l.process_type === 'Natural') { resource = 'patios_natural'; stageLabel = 'Patios N'; }
      else { resource = 'patios_hl'; stageLabel = 'Patios H/L'; }
      for (const d of weekDays) occByDay[d][resource] += kg;
      gantt.push({
        kind: 'real', label, process: l.process_type,
        kg_input: round2(kg),
        stages: [{ stage: stageLabel, category: 'drying',
          resource, from: weekDays[0], to: weekDays[6], kg }],
      });
    }
    // Resting/Trilla/Ready actuales: omitidos del flujo (no compiten
    // por ferm ni secado, y no quiero contarlos doblemente en el
    // balance porque ya pasaron por la planta).
  }

  // ── Baches planeados ───────────────────────────────────────────
  for (const dayEntry of planDays || []) {
    for (const batch of dayEntry.batches || []) {
      const stages = timelineFor(batch, dayEntry.date);
      gantt.push({
        kind: batch.kind,
        label: batch.order_code || 'A designar',
        client_name: batch.client_name,
        reference_name: batch.reference_name,
        process: batch.process_type,
        kg_green: batch.kg_green,
        kg_input: batch.kg_input,
        stage_input: batch.stage_input,
        start_date: dayEntry.date,
        stages,
      });

      // Acumular ocupación día a día sobre cada recurso
      for (const s of stages) {
        for (const d of dateRangeInclusive(s.from, s.to)) {
          if (occByDay[d]) occByDay[d][s.resource] += s.kg;
        }
      }

      // Balance por etapa: 'in' el día s.from, 'out' el día s.to (sale
      // ese día y entra a la siguiente). Solo contar dentro de la
      // semana objetivo.
      for (const s of stages) {
        if (stageBalance[s.from]) stageBalance[s.from][s.category].in  += s.kg;
        if (stageBalance[s.to])   stageBalance[s.to][s.category].out   += s.kg;
      }
    }
  }

  // Cuellos solo sobre los 4 recursos físicos (no resting/ready).
  const bottlenecks = [];
  for (const d of weekDays) {
    const occ = occByDay[d];
    const checks = [
      { resource: 'fermentation',    label: 'Fermentación',   limit: CAPACITY.fermentation_kg },
      { resource: 'mecanico',        label: 'Mecánico',       limit: CAPACITY.mecanico_kg },
      { resource: 'patios_natural',  label: 'Patios Natural', limit: CAPACITY.patios_natural_kg },
      { resource: 'patios_hl',       label: 'Patios H/L',     limit: CAPACITY.patios_hl_kg },
    ];
    for (const c of checks) {
      const used = occ[c.resource] || 0;
      if (used > c.limit + 0.01) {
        bottlenecks.push({
          day: d, resource: c.resource, label: c.label,
          kg: round2(used), limit: c.limit, over_kg: round2(used - c.limit),
        });
      }
    }
  }

  // Redondeo
  for (const d of Object.keys(occByDay)) {
    for (const k of Object.keys(occByDay[d])) occByDay[d][k] = round2(occByDay[d][k]);
  }
  for (const d of Object.keys(stageBalance)) {
    for (const cat of Object.keys(stageBalance[d])) {
      stageBalance[d][cat].in  = round2(stageBalance[d][cat].in);
      stageBalance[d][cat].out = round2(stageBalance[d][cat].out);
    }
  }

  return { gantt, daily_occupancy: occByDay, stage_balance: stageBalance, bottlenecks };
}

module.exports = { computePlan, plantSnapshot, isoDays, simulateFlow, CAPACITY, DRYING_DAYS, FERM_DAYS };
