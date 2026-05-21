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

  // 2. Capacidad de fermentación excedida por día (snapshot inicial
  // + lo que entra ese día). Modelo bruto: la planta no libera ferm
  // entre días dentro del horizonte; si excede, alertamos.
  const fermInitial = snapshot.fermentation_used_kg;
  for (const d of plan) {
    const total = fermInitial + d.ferm_used;
    if (total > CAPACITY.fermentation_kg + 0.01) {
      alerts.push({
        kind: 'capacity_exceeded',
        day: d.date,
        resource: 'fermentation',
        message: `Capacidad de fermentación excedida el ${d.date}: ${round2(total)} / ${CAPACITY.fermentation_kg} kg.`,
      });
    }
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
  };
}

module.exports = { computePlan, plantSnapshot, isoDays, CAPACITY, DRYING_DAYS };
