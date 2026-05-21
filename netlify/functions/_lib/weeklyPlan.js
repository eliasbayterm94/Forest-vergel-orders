'use strict';

/**
 * Motor de planeación semanal. Heurística greedy:
 *
 *  1. Recoge la cola de pedidos activos ordenados por urgencia.
 *  2. Asigna ingresos (cereza / despulpado / seco) a pedidos respetando
 *     reglas de proceso:
 *         · Pedido Natural → solo cereza.
 *         · Pedido Honey/Lavado → prioriza seco, luego despulpado,
 *           luego cereza.
 *  3. El excedente (input que sobra después de cubrir pedidos) se
 *     programa como bache "a designar" en el proceso con más capacidad
 *     libre esa semana.
 *  4. Distribuye los baches en los días que el operador indicó como
 *     llegada, verificando capacidades:
 *         · Fermentación 25.000 kg simultáneos.
 *         · Mecánico 5.000 kg simultáneos (3d H/L, 5d N).
 *         · Patios Natural 20.000 kg simultáneos (10d).
 *         · Patios Honey/Lavado 40.000 kg simultáneos (6d).
 *  5. Emite alertas cuando un día excede capacidad o un pedido queda
 *     sin cobertura suficiente vs su fecha de entrega.
 *
 * Devuelve { plan, alerts, feasibility_pct }.
 *
 * Inputs:
 *   weekStartDate: 'YYYY-MM-DD' (lunes ISO)
 *   dayInputs:     { 'YYYY-MM-DD': { cereza, despulpado, seco } }
 *   orders:        cola activa con remaining_kg_verde calculado
 *   lots:          baches en curso (para ocupación inicial)
 *   leadByProcess: { Natural, Honey, Lavado } → drying_days
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

// Stage divisors: kg input → kg green. Necesario para saber cuánto
// input necesita un pedido para cubrir N kg verde.
function kgInputForGreen(kgGreen, fromStage) {
  const div = INPUT_TO_GREEN[fromStage];
  if (!div) return null;
  return kgGreen * div;
}

// Pedidos elegibles para procesamiento desde un stage dado.
function processCompatibleWithStage(process, stage) {
  if (stage === 'cereza') return true;            // cereza sirve para todo
  if (stage === 'despulpado') return process !== 'Natural';
  if (stage === 'seco')       return process !== 'Natural';
  return false;
}

function isoDays(weekStartDate) {
  const out = [];
  const d = new Date(weekStartDate + 'T00:00:00Z');
  for (let i = 0; i < 7; i++) {
    const day = new Date(d.getTime() + i * 86400000);
    out.push(day.toISOString().slice(0, 10));
  }
  return out;
}

function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return 0;
  const a = new Date(fromIso + 'T00:00:00Z');
  const b = new Date(toIso   + 'T00:00:00Z');
  return Math.floor((b - a) / 86400000);
}

// Capacidad libre del proceso en kg simultáneos al inicio de la semana.
// (Modelo simplificado: ocupación actual de baches en cada recurso.)
function plantSnapshot(lots) {
  let ferm = 0;
  let mec  = 0;
  let patN = 0;
  let patHL = 0;
  for (const l of lots || []) {
    const kgGreen = Number(l.kg_green_expected || l.kg_green_actual || 0);
    if (l.status === 'InFermentation') ferm += kgGreen;
    if (l.status === 'Drying') {
      const locs = Array.isArray(l.drying_locations) ? l.drying_locations : [];
      const goesPatios   = locs.includes('Patio');
      const goesMecanico = locs.includes('Silos'); // mapping operativo
      // Si está en ambos, repartimos por defecto a patios (más capacidad).
      // Para el snapshot esto es aproximado; el operador puede corregir
      // en la vista si hace falta.
      if (goesMecanico && !goesPatios) {
        mec += kgGreen;
      } else if (l.process_type === 'Natural') {
        patN += kgGreen;
      } else {
        patHL += kgGreen;
      }
    }
  }
  return {
    fermentation_used_kg: round2(ferm),
    mecanico_used_kg:     round2(mec),
    patios_natural_used_kg: round2(patN),
    patios_hl_used_kg:    round2(patHL),
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

// ── Algoritmo principal ────────────────────────────────────────────
function computePlan({ weekStartDate, dayInputs, orders, lots }) {
  const days = isoDays(weekStartDate);
  const snapshot = plantSnapshot(lots);

  // Inputs totales por tipo (para asignación greedy)
  const totals = { cereza: 0, despulpado: 0, seco: 0 };
  const inputPerDay = {};
  for (const d of days) {
    const di = dayInputs[d] || {};
    inputPerDay[d] = {
      cereza:     Number(di.cereza     || 0),
      despulpado: Number(di.despulpado || 0),
      seco:       Number(di.seco       || 0),
    };
    totals.cereza     += inputPerDay[d].cereza;
    totals.despulpado += inputPerDay[d].despulpado;
    totals.seco       += inputPerDay[d].seco;
  }

  // Ordenar pedidos por urgencia (max_delivery_date asc). Mantiene los
  // que ya tienen kg en producción primero para no fragmentarlos.
  const activeOrders = (orders || []).filter((o) => Number(o.remaining_kg || 0) > 0.01);
  activeOrders.sort((a, b) => {
    const da = a.max_delivery_date || '9999-99-99';
    const db = b.max_delivery_date || '9999-99-99';
    if (da !== db) return da.localeCompare(db);
    // Tie-break: pedidos ya InProduction primero.
    const sa = a.status === 'InProduction' ? 0 : 1;
    const sb = b.status === 'InProduction' ? 0 : 1;
    return sa - sb;
  });

  const alerts = [];
  const assignments = []; // { order_id, process, stage, kg_input, kg_green, ... }
  const remaining = { ...totals };

  // 1. Asignar input a cada pedido respetando reglas
  for (const order of activeOrders) {
    const process = order.process_type;
    let kgGreenNeeded = Number(order.remaining_kg || 0);
    if (kgGreenNeeded <= 0) continue;

    // Orden preferido de stages por proceso:
    //   Natural → cereza
    //   Honey/Lavado → seco, despulpado, cereza
    const stageOrder = process === 'Natural'
      ? ['cereza']
      : ['seco', 'despulpado', 'cereza'];

    for (const stage of stageOrder) {
      if (kgGreenNeeded <= 0.01) break;
      if (remaining[stage] <= 0.01) continue;
      const inputNeeded = kgInputForGreen(kgGreenNeeded, stage);
      const take = Math.min(remaining[stage], inputNeeded);
      const kgGreen = take / INPUT_TO_GREEN[stage];
      assignments.push({
        kind: 'order',
        order_id: order.id,
        order_code: order.order_code,
        reference_name: order.reference_name,
        client_name: order.client_name,
        max_delivery_date: order.max_delivery_date,
        process_type: process,
        stage_input: stage,
        kg_input: round2(take),
        kg_green: round2(kgGreen),
      });
      remaining[stage] -= take;
      kgGreenNeeded -= kgGreen;
    }

    // Si quedó kg verde por cubrir, alerta de cobertura parcial.
    if (kgGreenNeeded > 0.01) {
      alerts.push({
        kind: 'partial_coverage',
        order_id: order.id,
        message: `Pedido ${order.order_code} queda con cobertura parcial — falta ${round2(kgGreenNeeded)} kg verde para la entrega del ${order.max_delivery_date}.`,
      });
    }
  }

  // 2. Excedente → "a designar" al proceso con más capacidad libre
  const excessAssignments = buildExcessAssignments(remaining);
  assignments.push(...excessAssignments);

  // 3. Distribuir los assignments por días respetando capacidades.
  //    Estrategia: ordenar por urgencia (orders primero); rellenar el
  //    primer día con capacidad de fermentación. Las llegadas guían el
  //    día base (no podemos fermentar lo que aún no llegó).
  const plan = days.map((d) => ({
    date: d,
    arrivals: { ...inputPerDay[d] },
    batches: [],
    ferm_used: 0, // ocupación de la planificación
    mec_used: 0,
    patN_used: 0,
    patHL_used: 0,
  }));

  // Pool de input disponible por día acumulado.
  const pool = {
    cereza:     days.map((d) => inputPerDay[d].cereza),
    despulpado: days.map((d) => inputPerDay[d].despulpado),
    seco:       days.map((d) => inputPerDay[d].seco),
  };

  function consumeFromPool(stage, kg) {
    // Consume kg desde el primer día con disponibilidad.
    for (let i = 0; i < days.length; i++) {
      const have = pool[stage][i];
      if (have <= 0.01) continue;
      const take = Math.min(have, kg);
      pool[stage][i] -= take;
      kg -= take;
      if (kg <= 0.01) return { dayIndex: i };
    }
    return { dayIndex: 0, leftover: kg }; // si no alcanza, va el día 0 por default
  }

  for (const a of assignments) {
    const { dayIndex } = consumeFromPool(a.stage_input, a.kg_input);
    const day = plan[dayIndex];
    day.batches.push(a);

    // Ocupación de fermentación = kg green planificado (snapshot del recurso).
    day.ferm_used += a.kg_green;

    // Para secado, calculamos cuándo entrará y a dónde.
    // Decisión: bache pequeño (<2000 kg verde) → mecánico, grande → patios.
    const useMecanico = a.kg_green < 2000;
    a.target_dryer = useMecanico ? 'Mecánico' : 'Patios';
  }

  // 4. Alertas por capacidad excedida en cualquier día (snapshot
  // simplificado: solo verifica fermentación bruta acumulada).
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

  // 5. Feasibility: % de pedidos que quedaron completamente cubiertos.
  const totalOrders = activeOrders.length || 1;
  const partials = alerts.filter((a) => a.kind === 'partial_coverage').length;
  const feasibility_pct = round2(((totalOrders - partials) / totalOrders) * 100);

  // 6. Excedente info-alert si hay
  const remainingKg = remaining.cereza + remaining.despulpado + remaining.seco;
  if (remainingKg > 0.01) {
    alerts.push({
      kind: 'excess',
      message: `${round2(remainingKg)} kg sin pedido asociado se programan como "a designar".`,
    });
  }

  return {
    plan,
    alerts,
    feasibility_pct,
    snapshot,
    totals,
  };
}

function buildExcessAssignments(remaining) {
  const out = [];
  // Excedente cereza → "a designar" en el proceso con más capacidad
  // libre. Heurística simple: si hay menos baches honey/lavado en
  // patios, va a honey. Para MVP, default a Honey.
  if (remaining.cereza > 0.01) {
    out.push(makeExcessBatch('cereza', remaining.cereza, 'Honey'));
    remaining.cereza = 0;
  }
  if (remaining.despulpado > 0.01) {
    out.push(makeExcessBatch('despulpado', remaining.despulpado, 'Honey'));
    remaining.despulpado = 0;
  }
  if (remaining.seco > 0.01) {
    out.push(makeExcessBatch('seco', remaining.seco, 'Lavado'));
    remaining.seco = 0;
  }
  return out;
}

function makeExcessBatch(stage, kg, defaultProcess) {
  return {
    kind: 'excess',
    order_id: null,
    order_code: null,
    reference_name: 'A designar',
    client_name: null,
    max_delivery_date: null,
    process_type: defaultProcess,
    stage_input: stage,
    kg_input: round2(kg),
    kg_green: round2(kg / INPUT_TO_GREEN[stage]),
  };
}

module.exports = { computePlan, plantSnapshot, isoDays, CAPACITY, DRYING_DAYS };
