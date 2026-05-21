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

// Capacidades simultáneas. Fermentación y los secadores son recursos
// compartidos: en el mismo tanque/patio puede haber cereza Natural y
// despulpado H/L al tiempo. Como ocupan distinto espacio por kg, las
// capacidades se modelan como fracciones por proceso:
//
//   ocupación_total = sum sobre baches de (kg_actual / cap_base_proceso)
//   saturado cuando ocupación_total > 1.0
//
// CAP exporta los kg "puros" para el caso de un solo proceso (uso en
// snapshot inicial y mostrar al usuario).
const CAPACITY = {
  fermentation_kg: 40000,            // tanque de ferm: 40k físicos
  mecanico_natural_kg: 12000,        // cereza sola al mecánico
  mecanico_hl_kg: 10000,             // despulpado solo al mecánico
  patios_natural_kg: 60000,          // cereza sola en patios
  patios_hl_kg: 100000,              // despulpado solo en patios
};

// Bases por (secadero × proceso) — usadas para el cálculo de fracción
// cuando el recurso está mezclado.
const DRYER_BASIS = {
  mecanico: { Natural: 12000, Honey: 10000, Lavado: 10000 },
  patios:   { Natural: 60000, Honey: 100000, Lavado: 100000 },
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

// Snapshot inicial de planta. Para los secadores compartidos
// devuelve tanto kg físicos totales como % de capacidad utilizada
// (suma de fracciones por proceso).
function plantSnapshot(lots) {
  let ferm = 0;
  let mecKg = 0, mecFrac = 0;
  let patKg = 0, patFrac = 0;
  for (const l of lots || []) {
    const kg = Number(l.kg_input_initial || l.kg_cherry_input
      || (Number(l.kg_green_expected || l.kg_green_actual || 0) * 7.65) || 0);
    if (l.status === 'InFermentation') ferm += kg;
    if (l.status === 'Drying') {
      const locs = Array.isArray(l.drying_locations) ? l.drying_locations : [];
      const useMecanico = locs.includes('Silos') && !locs.includes('Patio');
      const dryer = useMecanico ? 'mecanico' : 'patios';
      const basis = (DRYER_BASIS[dryer] || {})[l.process_type] || null;
      const frac = basis ? kg / basis : 0;
      if (useMecanico) { mecKg += kg; mecFrac += frac; }
      else             { patKg += kg; patFrac += frac; }
    }
  }
  return {
    fermentation_used_kg: round2(ferm),
    mecanico_used_kg:     round2(mecKg),
    mecanico_used_pct:    round2(mecFrac * 100),
    patios_used_kg:       round2(patKg),
    patios_used_pct:      round2(patFrac * 100),
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
    const msg = b.resource === 'fermentation'
      ? `${b.label}: ${fmtNum(b.kg)} / ${fmtNum(b.limit)} kg el ${b.day} (excede ${fmtNum(b.over_kg)} kg).`
      : `${b.label}: ${b.pct}% capacidad usada el ${b.day} (${fmtNum(b.kg)} kg físicos, excede ${b.over_pct}%).`;
    alerts.push({
      kind: 'capacity_exceeded', day: b.day, resource: b.resource, message: msg,
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

  // ── 0. Despulpado (instantáneo, ANTES de fermentar para H/L) ──
  // Si llega cereza a un pedido Honey/Lavado, se despulpa primero y
  // lo que entra al tanque de fermentación es despulpado (kg/2).
  let kgCurrent = batch.kg_input;
  let despulpadoAction = null;
  if (stage_input === 'cereza' && isHL) {
    const kgPulped = kgCurrent / CHERRY_TO_PULPED;
    despulpadoAction = { kg_cereza_in: kgCurrent, kg_despulpado_out: kgPulped };
    kgCurrent = kgPulped;
  }

  // ── 1. Fermentación ──────────────────────────────────────────
  // · Natural: fermenta cereza.
  // · H/L: fermenta despulpado (post-despulpe).
  // · Despulpado/seco directos: no fermentan (vienen post-ferm).
  const needsFerm = stage_input === 'cereza';
  if (needsFerm) {
    const fermDays = FERM_DAYS[proc] || 0;
    if (fermDays > 0) {
      const end = addDaysISO(cursor, fermDays - 1);
      stages.push({
        stage: 'Fermentación', category: 'fermentation', resource: 'fermentation',
        from: cursor, to: end,
        kg_initial: kgCurrent, kg_final: kgCurrent,
        process: proc,
        despulpado_action: despulpadoAction, // visible solo en la primera etapa
      });
      cursor = addDaysISO(end, 1);
    }
  }

  // ── 2. Secado (recurso unificado mecanico/patios) ────────────
  if (stage_input !== 'seco') {
    const dryer = batch.target_dryer === 'Mecánico' ? 'mecanico' : 'patios';
    const dryingDays = (DRYING_DAYS[dryer] && DRYING_DAYS[dryer][proc]) || 0;
    const factor = (DRYING_FACTOR[dryer] && DRYING_FACTOR[dryer][proc]) || 1;
    const kgDryEnd = kgCurrent / factor;
    if (dryingDays > 0) {
      const end = addDaysISO(cursor, dryingDays - 1);
      stages.push({
        stage: dryer === 'mecanico' ? 'Mecánico' : 'Patios',
        category: 'drying',
        resource: dryer, // 'mecanico' o 'patios' — compartido entre procesos
        from: cursor, to: end,
        kg_initial: kgCurrent, kg_final: kgDryEnd,
        process: proc,
        capacity_basis: DRYER_BASIS[dryer][proc] || null,
        humidity_start: HUMIDITY_START, humidity_end: HUMIDITY_END,
      });
      cursor = addDaysISO(end, 1);
      kgCurrent = kgDryEnd;
    }
  }

  // ── 3. Reposo ─────────────────────────────────────────────────
  if (RESTING_DAYS > 0) {
    const end = addDaysISO(cursor, RESTING_DAYS - 1);
    stages.push({
      stage: 'Reposo', category: 'resting', resource: 'resting',
      from: cursor, to: end, kg_initial: kgCurrent, kg_final: kgCurrent,
      process: proc,
    });
    cursor = addDaysISO(end, 1);
  }

  // ── 4. Listo para bodega ─────────────────────────────────────
  stages.push({
    stage: 'Listo', category: 'ready', resource: 'ready',
    from: cursor, to: cursor, kg_initial: kgCurrent, kg_final: kgCurrent,
    process: proc,
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
  // Recursos: fermentación (cap fija 40k) + secadores compartidos
  // (sumamos kg físicos + fracción de capacidad por proceso) + reposo
  // + listo. Fracción se compara contra 1.0 para detectar saturación.
  const occByDay = {};
  for (const d of horizon) {
    occByDay[d] = {
      fermentation: 0,
      mecanico_kg: 0,   mecanico_frac: 0,
      patios_kg: 0,     patios_frac: 0,
      resting: 0,       ready: 0,
    };
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
  // bruto inicial) y para secadores compartidos sumamos la fracción
  // según el proceso del bache.
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
          kg_initial: kg, kg_final: kg, process: l.process_type }],
      });
    } else if (l.status === 'Drying') {
      const locs = Array.isArray(l.drying_locations) ? l.drying_locations : [];
      const useMecanico = locs.includes('Silos') && !locs.includes('Patio');
      const dryer = useMecanico ? 'mecanico' : 'patios';
      const basis = (DRYER_BASIS[dryer] || {})[l.process_type] || null;
      const frac = basis ? kg / basis : 0;
      for (const d of weekDays) {
        occByDay[d][dryer === 'mecanico' ? 'mecanico_kg' : 'patios_kg'] += kg;
        occByDay[d][dryer === 'mecanico' ? 'mecanico_frac' : 'patios_frac'] += frac;
      }
      gantt.push({
        kind: 'real', label, process: l.process_type,
        kg_input: round2(kg),
        stages: [{ stage: dryer === 'mecanico' ? 'Mecánico' : 'Patios',
          category: 'drying', resource: dryer,
          from: weekDays[0], to: weekDays[6],
          kg_initial: kg, kg_final: kg,
          process: l.process_type, capacity_basis: basis }],
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

      // Ocupación día a día — curva lineal de peso. Para secadores
      // (mecanico/patios) acumulamos kg físicos y fracción de
      // capacidad por proceso (recurso compartido).
      for (const s of stages) {
        for (const d of dateRangeInclusive(s.from, s.to)) {
          if (!occByDay[d]) continue;
          const w = weightOnDay(s, d);
          if (s.resource === 'mecanico' || s.resource === 'patios') {
            occByDay[d][s.resource + '_kg'] += w;
            if (s.capacity_basis) {
              occByDay[d][s.resource + '_frac'] += w / s.capacity_basis;
            }
            if (candidatesByDay[d]) {
              const h = humidityOnDay(s, d);
              candidatesByDay[d].push({
                label: batch.order_code || 'A designar',
                resource: s.resource, current_kg: w, humidity: h,
              });
            }
          } else {
            occByDay[d][s.resource] += w;
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
  // Ferm: kg físicos vs cap (40k).
  // Secadores: fracción de capacidad (suma de kg/cap_proceso) > 1.0.
  const bottlenecks = [];
  for (const d of weekDays) {
    const occ = occByDay[d];
    if (occ.fermentation > CAPACITY.fermentation_kg + 0.01) {
      bottlenecks.push({
        day: d, resource: 'fermentation', label: 'Fermentación',
        kg: round2(occ.fermentation), limit: CAPACITY.fermentation_kg,
        over_kg: round2(occ.fermentation - CAPACITY.fermentation_kg),
      });
    }
    if (occ.mecanico_frac > 1.001) {
      bottlenecks.push({
        day: d, resource: 'mecanico', label: 'Mecánico',
        kg: round2(occ.mecanico_kg), pct: round2(occ.mecanico_frac * 100), limit_pct: 100,
        over_pct: round2((occ.mecanico_frac - 1) * 100),
      });
    }
    if (occ.patios_frac > 1.001) {
      bottlenecks.push({
        day: d, resource: 'patios', label: 'Patios',
        kg: round2(occ.patios_kg), pct: round2(occ.patios_frac * 100), limit_pct: 100,
        over_pct: round2((occ.patios_frac - 1) * 100),
      });
    }
  }

  // ── Sugerencias ────────────────────────────────────────────────
  // 1) Pase temprano a reposo: cuando un día tiene un patio saturado
  // y existe en ese mismo día un bache con humedad ≤25% que ocupa ese
  // patio. Liberar ese bache descarga `current_kg`.
  const suggestions = [];
  const seen = new Set();
  for (const bn of bottlenecks) {
    if (bn.resource !== 'patios' && bn.resource !== 'mecanico') continue;
    const cands = (candidatesByDay[bn.day] || [])
      .filter((c) => c.resource === bn.resource && c.humidity != null && c.humidity <= HUMIDITY_EARLY_REST)
      .sort((a, b) => a.humidity - b.humidity);
    for (const c of cands) {
      const key = `${bn.day}|${c.label}|${bn.resource}`;
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push({
        kind: 'early_resting', day: bn.day, resource: bn.resource,
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
  // Si patios satura algún día Y hay excedente "a designar" Natural,
  // sugerir desviar parte a H/L. Como el recurso es compartido, la
  // ganancia viene de que H/L ocupa menos fracción de capacidad por
  // kg que Natural (1/100k vs 1/60k).
  const patSatDays = new Set(bottlenecks.filter((b) => b.resource === 'patios').map((b) => b.day));
  if (patSatDays.size > 0 && cherryExcessNatural > 0) {
    suggestions.push({
      kind: 'process_swap',
      message: `Patios saturado ${patSatDays.size} día(s). Hay ${fmtNum(cherryExcessNatural)} kg de cereza Natural sin pedido asociado. Si los procesas como Honey/Lavado, ocupan ~60% menos espacio en patios (base 100k vs 60k) y se secan más rápido.`,
    });
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

  // ── Pipeline de acciones operativas por día ────────────────────
  // Construye una lista de tareas concretas por día de la semana
  // para que el operador sepa qué hacer con lo que llega y con los
  // baches en curso (entradas, despulpes, transiciones entre etapas,
  // salidas a bodega).
  const actions = buildActionPipeline({ weekDays, gantt, bottlenecks, suggestions });

  return {
    gantt, daily_occupancy: occByDay, stage_balance: stageBalance,
    bottlenecks, suggestions, actions,
  };
}

function buildActionPipeline({ weekDays, gantt, bottlenecks, suggestions }) {
  const byDay = {};
  for (const d of weekDays) byDay[d] = [];

  for (const row of gantt) {
    // Acciones por etapa: 'arrival' (día de inicio), 'transition'
    // (entre etapas), 'ready' (día listo p/ bodega).
    const isReal = row.kind === 'real';
    const targetLabel = row.label
      + (row.client_name ? ' (' + row.client_name + ')' : '');

    for (let i = 0; i < row.stages.length; i++) {
      const s = row.stages[i];
      const next = row.stages[i + 1];

      // Acción de inicio: solo para baches planeados (los reales ya
      // están en curso, no hay "entrada" hoy).
      if (i === 0 && !isReal && byDay[s.from]) {
        if (s.despulpado_action) {
          byDay[s.from].push({
            type: 'arrival', icon: '↓',
            text: `Recibir ${fmtNum(s.despulpado_action.kg_cereza_in)} kg cereza ${row.process} · despulpar → ${fmtNum(s.despulpado_action.kg_despulpado_out)} kg para ${targetLabel}`,
            process: row.process, target: row.label,
          });
        } else if (row.stage_input === 'cereza') {
          byDay[s.from].push({
            type: 'arrival', icon: '↓',
            text: `Recibir ${fmtNum(row.kg_input)} kg cereza ${row.process} para ${targetLabel}`,
            process: row.process, target: row.label,
          });
        } else {
          byDay[s.from].push({
            type: 'arrival', icon: '↓',
            text: `Recibir ${fmtNum(row.kg_input)} kg ${row.stage_input} ${row.process} para ${targetLabel}`,
            process: row.process, target: row.label,
          });
        }
        byDay[s.from].push({
          type: 'start', icon: '•',
          text: `Iniciar ${s.stage.toLowerCase()} de ${targetLabel} (${fmtNum(s.kg_initial)} kg)`,
          process: row.process,
        });
      }

      // Acción de transición: el día siguiente al fin de la etapa
      // (cuando el bache pasa a la próxima). Solo si la próxima cae
      // dentro de la semana visible.
      if (next && byDay[next.from]) {
        const nextStageLabel = next.stage.toLowerCase();
        byDay[next.from].push({
          type: 'transition', icon: '↑',
          text: `Mover ${targetLabel} de ${s.stage.toLowerCase()} a ${nextStageLabel} (${fmtNum(s.kg_final)} kg)`,
          process: row.process,
        });
      }

      // Acción "listo para bodega".
      if (s.category === 'ready' && byDay[s.from]) {
        byDay[s.from].push({
          type: 'ready', icon: '✓',
          text: `${targetLabel} listo para bodega (${fmtNum(s.kg_initial)} kg seco)`,
          process: row.process,
        });
      }
    }
  }

  // Acciones derivadas de cuellos y sugerencias.
  for (const bn of bottlenecks) {
    if (!byDay[bn.day]) continue;
    const text = bn.resource === 'fermentation'
      ? `${bn.label} excedida: ${fmtNum(bn.kg)} / ${fmtNum(bn.limit)} kg`
      : `${bn.label} excedido: ${bn.pct}% capacidad (excede ${bn.over_pct}%)`;
    byDay[bn.day].push({ type: 'warning', icon: '⚠', text });
  }
  for (const s of suggestions || []) {
    const day = s.day || weekDays[0]; // las globales van al lunes
    if (!byDay[day]) continue;
    byDay[day].push({ type: 'suggestion', icon: '💡', text: s.message });
  }

  // Devolver array ordenado por día.
  return weekDays.map((d) => ({ date: d, actions: byDay[d] }));
}

function fmtNum(n) { return Math.round(n).toLocaleString('es-CO'); }

module.exports = { computePlan, plantSnapshot, isoDays, simulateFlow, CAPACITY, DRYING_DAYS, FERM_DAYS };
