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

// Capacidades simultáneas (kg físicos del momento, no kg verde).
// Patios y mecánico separan capacidad por proceso porque el material
// que entra es distinto (cereza vs despulpado) y ocupa diferente.
const CAPACITY = {
  fermentation_kg:     25000,
  mecanico_natural_kg: 12000,   // cereza al mecánico Natural
  mecanico_hl_kg:      10000,   // despulpado al mecánico H/L
  patios_natural_kg:   60000,   // cereza fresca a patios Natural
  patios_hl_kg:       100000,   // despulpado a patios H/L
};

// Factores de conversión de peso durante el secado, por (secadero, proceso).
// kg_entrada / factor = kg_seco a la salida.
const DRYING_FACTOR = {
  mecanico: { Natural: 3.0, Honey: 2.0, Lavado: 2.0 },
  patios:   { Natural: 3.4, Honey: 2.0, Lavado: 2.0 },
};

// Cereza → despulpado en procesos Honey/Lavado: la mitad del peso.
// (20.000 kg cereza → 10.000 kg despulpado.)
const CHERRY_TO_PULPED = 2.0;

const DRYING_DAYS = {
  mecanico: { Natural: 5, Honey: 3, Lavado: 3 },
  patios:   { Natural: 10, Honey: 6, Lavado: 6 },
};

// Fermentación por proceso (límite superior conservador).
const FERM_DAYS = { Natural: 2, Honey: 3, Lavado: 3 };

// Humedad: el café entra al secado al 60% y sale al 12%.
const HUMIDITY_START = 60;
const HUMIDITY_END   = 12;

// Umbral de humedad para que un bache pueda salir del patio
// anticipadamente a reposo (libera capacidad).
const HUMIDITY_EARLY_REST = 25;

const RESTING_DAYS = 7;
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

// Snapshot inicial de planta para los semáforos de capacidad. Usa kg
// físicos (kg_input_initial) — mismo principio que el simulador.
function plantSnapshot(lots) {
  let ferm = 0, mecN = 0, mecHL = 0, patN = 0, patHL = 0;
  for (const l of lots || []) {
    const kg = Number(l.kg_input_initial || l.kg_cherry_input
      || (Number(l.kg_green_expected || l.kg_green_actual || 0) * 7.65) || 0);
    if (l.status === 'InFermentation') ferm += kg;
    if (l.status === 'Drying') {
      const locs = Array.isArray(l.drying_locations) ? l.drying_locations : [];
      const useMecanico = locs.includes('Silos') && !locs.includes('Patio');
      if (useMecanico) {
        if (l.process_type === 'Natural') mecN += kg;
        else mecHL += kg;
      } else if (l.process_type === 'Natural') {
        patN += kg;
      } else {
        patHL += kg;
      }
    }
  }
  return {
    fermentation_used_kg:     round2(ferm),
    mecanico_natural_used_kg: round2(mecN),
    mecanico_hl_used_kg:      round2(mecHL),
    patios_natural_used_kg:   round2(patN),
    patios_hl_used_kg:        round2(patHL),
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
  const flow = simulateFlow({ weekStartDate, planDays: plan, lots, totals });
  for (const b of flow.bottlenecks) {
    alerts.push({
      kind: 'capacity_exceeded',
      day: b.day,
      resource: b.resource,
      message: `${b.label}: ${b.kg} / ${b.limit} kg el ${b.day} (excede ${b.over_kg} kg).`,
    });
  }
  for (const s of flow.suggestions || []) {
    alerts.push({ kind: 'suggestion', subkind: s.kind, day: s.day, message: s.message });
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
// de entrada. Cada etapa lleva:
//   · category   — fermentation/drying/resting/ready (para balance)
//   · resource   — bucket de capacidad para el heatmap
//   · kg_initial — masa al inicio de la etapa
//   · kg_final   — masa al final de la etapa (curva lineal entre ambos)
// Las capacidades de planta se miden en kg físicos, no en verde.
function timelineFor(batch, startDate) {
  const stages = [];
  let cursor = startDate;
  const stage_input = batch.stage_input;
  const proc = batch.process_type;
  const isHL = proc === 'Honey' || proc === 'Lavado';

  // ── 1. Fermentación ────────────────────────────────────────────
  // Solo cuando entra como cereza. La cereza Honey/Lavado fermenta
  // primero (en cereza) y luego se despulpa al iniciar el secado.
  // Sin pérdida de peso (lo que entra sale).
  const fermDays = stage_input === 'cereza' ? (FERM_DAYS[proc] || 0) : 0;
  let kgPostFerm = batch.kg_input; // masa al salir de fermentación
  if (fermDays > 0) {
    const end = addDaysISO(cursor, fermDays - 1);
    stages.push({
      stage: 'Fermentación', category: 'fermentation', resource: 'fermentation',
      from: cursor, to: end, kg_initial: kgPostFerm, kg_final: kgPostFerm,
    });
    cursor = addDaysISO(end, 1);
  }

  // ── 2. Despulpado (instantáneo, solo si cereza llega a H/L) ────
  // Reduce el peso a la mitad. No ocupa capacidad de planta (es paso).
  let kgEnteringDryer = kgPostFerm;
  if (stage_input === 'cereza' && isHL) {
    kgEnteringDryer = kgPostFerm / CHERRY_TO_PULPED;
  }

  // ── 3. Secado ──────────────────────────────────────────────────
  if (stage_input !== 'seco') {
    const dryer = batch.target_dryer === 'Mecánico' ? 'mecanico' : 'patios';
    const dryingDays = (DRYING_DAYS[dryer] && DRYING_DAYS[dryer][proc]) || 0;
    let resource = null, stageLabel = null;
    if (dryer === 'mecanico') {
      if (proc === 'Natural') { resource = 'mecanico_natural'; stageLabel = 'Mecánico N'; }
      else                    { resource = 'mecanico_hl';      stageLabel = 'Mecánico H/L'; }
    } else {
      if (proc === 'Natural') { resource = 'patios_natural';   stageLabel = 'Patios N'; }
      else                    { resource = 'patios_hl';        stageLabel = 'Patios H/L'; }
    }
    const factor = (DRYING_FACTOR[dryer] && DRYING_FACTOR[dryer][proc]) || 1;
    const kgDryEnd = kgEnteringDryer / factor;

    if (dryingDays > 0 && resource) {
      const end = addDaysISO(cursor, dryingDays - 1);
      stages.push({
        stage: stageLabel, category: 'drying', resource,
        from: cursor, to: end,
        kg_initial: kgEnteringDryer, kg_final: kgDryEnd,
        humidity_start: HUMIDITY_START, humidity_end: HUMIDITY_END,
      });
      cursor = addDaysISO(end, 1);
      kgEnteringDryer = kgDryEnd; // ahora es kg seco
    }
  }
  const kgPostDry = kgEnteringDryer; // kg seco (o kg input si era 'seco' ya)

  // ── 4. Reposo (peso constante: ya está seco) ───────────────────
  if (RESTING_DAYS > 0) {
    const end = addDaysISO(cursor, RESTING_DAYS - 1);
    stages.push({
      stage: 'Reposo', category: 'resting', resource: 'resting',
      from: cursor, to: end, kg_initial: kgPostDry, kg_final: kgPostDry,
    });
    cursor = addDaysISO(end, 1);
  }

  // ── 5. Listo para bodega (día marcador) ────────────────────────
  stages.push({
    stage: 'Listo', category: 'ready', resource: 'ready',
    from: cursor, to: cursor, kg_initial: kgPostDry, kg_final: kgPostDry,
  });

  return stages;
}

// Peso lineal interpolado dentro de una etapa para el día absoluto.
function weightOnDay(stage, isoDate) {
  const offset = daysBetween(stage.from, isoDate);
  const span = Math.max(0, daysBetween(stage.from, stage.to));
  if (span === 0) return stage.kg_initial;
  const t = Math.max(0, Math.min(1, offset / span));
  return stage.kg_initial - (stage.kg_initial - stage.kg_final) * t;
}

// Humedad estimada lineal entre HUMIDITY_START y HUMIDITY_END durante
// el secado (sirve para sugerir pases tempranos).
function humidityOnDay(stage, isoDate) {
  if (stage.category !== 'drying') return null;
  const offset = daysBetween(stage.from, isoDate);
  const span = Math.max(0, daysBetween(stage.from, stage.to));
  if (span === 0) return stage.humidity_end;
  const t = Math.max(0, Math.min(1, offset / span));
  return HUMIDITY_START - (HUMIDITY_START - HUMIDITY_END) * t;
}

function daysBetween(fromIso, toIso) {
  const a = new Date(fromIso + 'T00:00:00Z');
  const b = new Date(toIso   + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

function simulateFlow({ weekStartDate, planDays, lots, totals }) {
  const weekDays = isoDays(weekStartDate);
  const horizon = [];
  for (let i = 0; i < SIMULATION_HORIZON_DAYS; i++) {
    horizon.push(addDaysISO(weekStartDate, i));
  }
  const RES_KEYS = [
    'fermentation', 'mecanico_natural', 'mecanico_hl',
    'patios_natural', 'patios_hl', 'resting', 'ready',
  ];
  const occByDay = {};
  for (const d of horizon) {
    occByDay[d] = Object.fromEntries(RES_KEYS.map((k) => [k, 0]));
  }
  // Para el pase temprano: por (día, recurso) registramos qué baches
  // están en secado y a qué humedad estimada — si ≤25% son candidatos.
  const candidatesByDay = {};
  for (const d of weekDays) candidatesByDay[d] = [];

  const stageBalance = {};
  for (const d of weekDays) {
    stageBalance[d] = {
      fermentation: { in: 0, out: 0 },
      drying:       { in: 0, out: 0 },
      resting:      { in: 0, out: 0 },
      ready:        { in: 0, out: 0 },
    };
  }

  const gantt = [];

  // ── Baches reales (no Delivered) ───────────────────────────────
  // Ocupación constante esta semana. Usamos kg_input_initial (peso
  // bruto inicial). El peso seco se asume aprox (no curva — no
  // sabemos cuánto llevan).
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
          resource: 'fermentation', from: weekDays[0], to: weekDays[6],
          kg_initial: kg, kg_final: kg }],
      });
    } else if (l.status === 'Drying') {
      const locs = Array.isArray(l.drying_locations) ? l.drying_locations : [];
      const useMecanico = locs.includes('Silos') && !locs.includes('Patio');
      let resource, stageLabel;
      if (useMecanico) {
        if (l.process_type === 'Natural') { resource = 'mecanico_natural'; stageLabel = 'Mecánico N'; }
        else                              { resource = 'mecanico_hl';      stageLabel = 'Mecánico H/L'; }
      } else {
        if (l.process_type === 'Natural') { resource = 'patios_natural';   stageLabel = 'Patios N'; }
        else                              { resource = 'patios_hl';        stageLabel = 'Patios H/L'; }
      }
      for (const d of weekDays) occByDay[d][resource] += kg;
      gantt.push({
        kind: 'real', label, process: l.process_type,
        kg_input: round2(kg),
        stages: [{ stage: stageLabel, category: 'drying',
          resource, from: weekDays[0], to: weekDays[6],
          kg_initial: kg, kg_final: kg }],
      });
    }
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

      // Ocupación día a día — curva lineal de peso entre kg_initial y kg_final.
      for (const s of stages) {
        for (const d of dateRangeInclusive(s.from, s.to)) {
          if (!occByDay[d]) continue;
          const w = weightOnDay(s, d);
          occByDay[d][s.resource] += w;
          if (s.category === 'drying' && candidatesByDay[d]) {
            const h = humidityOnDay(s, d);
            candidatesByDay[d].push({
              label: batch.order_code || 'A designar',
              resource: s.resource, current_kg: w, humidity: h,
            });
          }
        }
      }

      // Balance por etapa: 'in' el día s.from (kg_initial), 'out' el
      // día s.to (kg_final — refleja la conversión aplicada en la etapa).
      for (const s of stages) {
        if (stageBalance[s.from]) stageBalance[s.from][s.category].in  += s.kg_initial;
        if (stageBalance[s.to])   stageBalance[s.to][s.category].out   += s.kg_final;
      }
    }
  }

  // ── Cuellos de botella ─────────────────────────────────────────
  const bottlenecks = [];
  const RESOURCE_CHECKS = [
    { resource: 'fermentation',     label: 'Fermentación',     limit: CAPACITY.fermentation_kg },
    { resource: 'mecanico_natural', label: 'Mecánico Natural', limit: CAPACITY.mecanico_natural_kg },
    { resource: 'mecanico_hl',      label: 'Mecánico H/L',     limit: CAPACITY.mecanico_hl_kg },
    { resource: 'patios_natural',   label: 'Patios Natural',   limit: CAPACITY.patios_natural_kg },
    { resource: 'patios_hl',        label: 'Patios H/L',       limit: CAPACITY.patios_hl_kg },
  ];
  for (const d of weekDays) {
    const occ = occByDay[d];
    for (const c of RESOURCE_CHECKS) {
      const used = occ[c.resource] || 0;
      if (used > c.limit + 0.01) {
        bottlenecks.push({
          day: d, resource: c.resource, label: c.label,
          kg: round2(used), limit: c.limit, over_kg: round2(used - c.limit),
        });
      }
    }
  }

  // ── Sugerencias ────────────────────────────────────────────────
  // 1) Pase temprano a reposo: cuando un día tiene un patio saturado
  // y existe en ese mismo día un bache con humedad ≤25% que ocupa ese
  // patio. Liberar ese bache descarga `current_kg`.
  const suggestions = [];
  const seen = new Set();
  for (const bn of bottlenecks) {
    if (!bn.resource.startsWith('patios_')) continue;
    const cands = (candidatesByDay[bn.day] || [])
      .filter((c) => c.resource === bn.resource && c.humidity != null && c.humidity <= HUMIDITY_EARLY_REST)
      .sort((a, b) => a.humidity - b.humidity); // los más secos primero
    for (const c of cands) {
      const key = `${bn.day}|${c.label}|${bn.resource}`;
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push({
        kind: 'early_resting',
        day: bn.day, resource: bn.resource,
        message: `Considera pasar ${c.label} a reposo anticipado el ${bn.day}: humedad estimada ${Math.round(c.humidity)}%, libera ~${fmtNum(c.current_kg)} kg de ${bn.label}.`,
      });
    }
  }

  // 2) Cambio de proceso: si patios_natural está saturado en algún
  // día y patios_hl tiene capacidad libre, sugerir desviar excedente
  // (cuando hay "a designar" Natural) a Honey/Lavado. Esto solo
  // aplica al excedente sin pedido fijo.
  const totalExcessCereza = (totals && totals.cereza) ? 0 : 0; // calculado abajo
  let cherryExcessNatural = 0;
  for (const dayEntry of planDays || []) {
    for (const b of dayEntry.batches || []) {
      if (b.kind === 'excess' && b.process_type === 'Natural' && b.stage_input === 'cereza') {
        cherryExcessNatural += Number(b.kg_input || 0);
      }
    }
  }
  const natOverDays = new Set(bottlenecks.filter((b) => b.resource === 'patios_natural').map((b) => b.day));
  if (natOverDays.size > 0 && cherryExcessNatural > 0) {
    // ¿Hay capacidad libre en patios_hl algún día de la semana?
    let freeHL = 0;
    for (const d of weekDays) {
      const free = CAPACITY.patios_hl_kg - (occByDay[d].patios_hl || 0);
      if (free > freeHL) freeHL = free;
    }
    if (freeHL > 1000) {
      suggestions.push({
        kind: 'process_swap',
        message: `Patios Natural saturado ${natOverDays.size} día(s). Hay ~${fmtNum(freeHL)} kg libres en patios H/L. Considera procesar parte del excedente Natural como Honey/Lavado (capacidad muy superior, sale más rápido).`,
      });
    }
  }

  // Redondeo final
  for (const d of Object.keys(occByDay)) {
    for (const k of Object.keys(occByDay[d])) occByDay[d][k] = round2(occByDay[d][k]);
  }
  for (const d of Object.keys(stageBalance)) {
    for (const cat of Object.keys(stageBalance[d])) {
      stageBalance[d][cat].in  = round2(stageBalance[d][cat].in);
      stageBalance[d][cat].out = round2(stageBalance[d][cat].out);
    }
  }

  return { gantt, daily_occupancy: occByDay, stage_balance: stageBalance, bottlenecks, suggestions };
}

function fmtNum(n) { return Math.round(n).toLocaleString('es-CO'); }

module.exports = { computePlan, plantSnapshot, isoDays, simulateFlow, CAPACITY, DRYING_DAYS, FERM_DAYS };
