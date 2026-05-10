// Admin-only dashboard. Cross-cutting view — combina señales de
// comercial (Forest) y producción (Finca) que normalmente viven en
// vistas separadas, mas tres graficos (trend mensual, pipeline kg,
// distribución por proceso) y una tabla de despachos recientes.

import { el } from '../ui/el.js';
import { fmtKg, fmtDate, statusLabel } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { navigate } from '../router.js';

const FERMENTATION_OVERRUN_DAYS = 5;
const PROCESSES = ['Natural', 'Honey', 'Lavado'];

const PROC_COLORS = {
  Natural: '#5d8b66',
  Honey:   '#ddae3e',
  Lavado:  '#7e9ec1',
};
const STAGE_COLORS = {
  InFermentation: '#7e9ec1',
  Drying:         '#ddae3e',
  Ready:          '#5d8b66',
};

export async function adminDashboardView() {
  const [ordersRes, lotsRes, shipsRes, leadRes] = await Promise.all([
    api.ordersList({}),
    api.lotsList({}),
    api.shipmentsList(),
    api.processLeadTimes().catch(() => ({ process_lead_times: [] })),
  ]);
  const today     = ordersRes.today;
  const orders    = ordersRes.orders || [];
  const lots      = lotsRes.lots || [];
  const shipments = shipsRes.shipments || [];
  const leadByProcess = new Map(
    (leadRes.process_lead_times || []).map((r) => [r.process_type, r]),
  );

  const m = computeMetrics({ orders, lots, shipments, today, leadByProcess });

  return chrome(el('div', {}, [
    pageTitle('Dashboard admin', `Hoy: ${today}`),

    sectionLabel('Operativos'),
    statRow([
      stat('kg verde despachado total', fmtKg(m.kgDespTotal),  `${shipments.length} despacho(s)`),
      stat('kg verde despachado mes',   fmtKg(m.kgDespMes),    momHint(m.kgDespMomDelta)),
      stat('Lotes activos',             String(m.lotsActivos), `${m.lotsReady} Ready · ${m.lotsDrying} Drying`),
      stat('Pedidos en curso',          String(m.pedidosEnCurso), `${m.pedidosPending} pendientes`),
    ]),

    sectionLabel('Estado de producción'),
    statRow([
      stat('kg verde sin asignar',     fmtKg(m.kgSinAsignar),       `${m.pedidosSinLote} pedidos sin lote`,
        m.kgSinAsignar > 0 ? 'warn' : 'ok'),
      stat('Fermentación vencida',     String(m.fermentacionVencida), `>${FERMENTATION_OVERRUN_DAYS}d en fermentación`,
        m.fermentacionVencida > 0 ? 'crit' : 'ok'),
      stat('Drying vencido',           String(m.dryingVencido),     'Excede días esperados',
        m.dryingVencido > 0 ? 'crit' : 'ok'),
      stat('Listos sin despachar',     String(m.listosSinDespachar), 'Lotes Ready'),
    ]),

    sectionLabel('Calidad / cumplimiento'),
    statRow([
      kpiCumplimiento(m.cumplimientoRate, m.cumplimientoTotal),
      kpiAceptacion(m.acceptanceRate, m.acceptanceCreated),
      factorByProcessCard(m.factorByProcess),
      stat('Parciales rechazados 3m',
        String(m.rejected3mCount),
        `${fmtKg(m.rejected3mKg)} verde perdido`,
        m.rejected3mCount > 0 ? 'warn' : null),
    ]),

    sectionLabel('Velocidad / ritmo'),
    statRow([
      stat('Tiempo de ciclo 3m',
        m.cycleAvg != null ? `${m.cycleAvg.toFixed(1)} d` : '—',
        `${m.cycleCount} pedidos completados`),
      stat('Respuesta finca 3m',
        m.respuestaAvg != null ? `${m.respuestaAvg.toFixed(1)} d` : '—',
        `${m.respuestaCount} pedidos respondidos`),
      stat('Lotes entregados mes',     String(m.lotsDeliveredMes), 'Status Delivered'),
      stat('Pedidos creados mes',      String(m.creadosMes),       momHint(m.creadosDelta)),
    ]),

    section('Trend mensual · kg verde (últimos 12 meses)',
      trendChart(m.trendMonthly)),

    section('Pipeline · kg verde por etapa',
      pipelineBar(m.pipelineKg)),

    section('Distribución por proceso · kg verde despachado (últimos 6 meses)',
      processDonut(m.kgByProcess6m)),

    section('Despachos recientes',
      recentShipmentsTable(m.recentShipments)),
  ]));
}

// ─── Metrics computation ────────────────────────────────────────────
function computeMetrics({ orders, lots, shipments, today, leadByProcess }) {
  const todayDate = new Date(today + 'T12:00:00Z');
  const thisMonth = today.slice(0, 7);
  const lastMonth = monthOffset(todayDate, -1);
  const last3 = [0, 1, 2].map((i) => monthOffset(todayDate, -i));
  const inLast3 = (s) => last3.includes((s || '').slice(0, 7));

  // Operativos
  const kgDespTotal = sum(shipments, (s) => s.totals?.kg_green || 0);
  const kgDespMes = sum(
    shipments.filter((s) => (s.shipment_date || '').slice(0, 7) === thisMonth),
    (s) => s.totals?.kg_green || 0,
  );
  const kgDespMesPrev = sum(
    shipments.filter((s) => (s.shipment_date || '').slice(0, 7) === lastMonth),
    (s) => s.totals?.kg_green || 0,
  );
  const kgDespMomDelta = kgDespMesPrev > 0 ? ((kgDespMes - kgDespMesPrev) / kgDespMesPrev) * 100 : null;

  const activeLots = lots.filter((l) => l.status !== 'Delivered');
  const lotsActivos  = activeLots.length;
  const lotsReady    = activeLots.filter((l) => l.status === 'Ready').length;
  const lotsDrying   = activeLots.filter((l) => l.status === 'Drying').length;
  const lotsFerm     = activeLots.filter((l) => l.status === 'InFermentation').length;

  const inFlight = orders.filter((o) =>
    ['Accepted','PartiallyAccepted','InProduction'].includes(o.status));
  const pedidosEnCurso = inFlight.length;
  const pedidosPending = orders.filter((o) => o.status === 'Pending').length;

  // Estado de producción
  const allocByOrder = new Map();
  for (const lot of activeLots) {
    for (const a of lot.assignments || []) {
      allocByOrder.set(a.demand_order_id,
        (allocByOrder.get(a.demand_order_id) || 0) + Number(a.kg_green_allocated || 0));
    }
  }
  let kgSinAsignar = 0;
  let pedidosSinLote = 0;
  for (const o of inFlight) {
    const accepted = Number(o.kg_green_accepted || 0);
    const allocated = allocByOrder.get(o.id) || 0;
    const pending = Math.max(0, accepted - allocated);
    if (pending > 0.001) {
      kgSinAsignar += pending;
      pedidosSinLote += 1;
    }
  }

  const fermentacionVencida = lots.filter((l) =>
    l.status === 'InFermentation' && daysBetween(l.start_date, today) > FERMENTATION_OVERRUN_DAYS).length;
  const dryingVencido = lots.filter((l) => {
    if (l.status !== 'Drying' || !l.drying_start_date) return false;
    const cfg = leadByProcess.get(l.process_type);
    if (!cfg) return false;
    return daysBetween(l.drying_start_date, today) > Number(cfg.drying_days);
  }).length;
  const shippedLotIds = new Set();
  shipments.forEach((s) => (s.lots || []).forEach((l) => shippedLotIds.add(l.id)));
  const listosSinDespachar = lots.filter((l) => l.status === 'Ready' && !shippedLotIds.has(l.id)).length;

  // Calidad / cumplimiento
  const completed3m = orders.filter((o) =>
    o.completed_at && inLast3(o.completed_at) && o.max_delivery_date);
  const onTime3m = completed3m.filter((o) =>
    (o.completed_at || '').slice(0, 10) <= o.max_delivery_date);
  const cumplimientoRate = completed3m.length > 0
    ? (onTime3m.length / completed3m.length) * 100 : null;

  const created3m = orders.filter((o) => inLast3(o.created_at));
  const accepted3m = created3m.filter((o) =>
    ['Accepted','PartiallyAccepted','InProduction','Completed'].includes(o.status));
  const acceptanceRate = created3m.length > 0
    ? (accepted3m.length / created3m.length) * 100 : null;

  // Factor por proceso (último mes con datos por proceso, no necesariamente
  // el mismo mes para todos).
  const deliveredAll = lots
    .filter((l) => l.status === 'Delivered' && l.factor_rendimiento != null)
    .sort((a, b) => (b.delivered_date || '').localeCompare(a.delivered_date || ''));
  const factorByProcess = {};
  for (const proc of PROCESSES) {
    const ls = deliveredAll.filter((l) => l.process_type === proc);
    if (ls.length === 0) {
      factorByProcess[proc] = { avg: null, month: null, count: 0 };
      continue;
    }
    const latestMonth = ls[0].delivered_date.slice(0, 7);
    const inMonth = ls.filter((l) => l.delivered_date.slice(0, 7) === latestMonth);
    factorByProcess[proc] = {
      avg: avg(inMonth.map((l) => Number(l.factor_rendimiento))),
      month: latestMonth, count: inMonth.length,
    };
  }

  let rejected3mCount = 0;
  let rejected3mKg = 0;
  for (const lot of lots) {
    for (const p of lot.partials || []) {
      if (!p.rejected_at) continue;
      if (!inLast3(p.rejected_at)) continue;
      rejected3mCount += 1;
      rejected3mKg += Number(p.kg_green_yield || 0);
    }
  }

  // Velocidad / ritmo
  const completedAll3m = orders.filter((o) =>
    o.completed_at && inLast3(o.completed_at) && o.created_at);
  const cycleAvg = completedAll3m.length > 0
    ? avg(completedAll3m.map((o) =>
        (new Date(o.completed_at) - new Date(o.created_at)) / 86400000)) : null;
  const cycleCount = completedAll3m.length;

  // Tiempo respuesta finca: created_at → accepted_at o rejected_at, dentro
  // de los últimos 3 meses (por la fecha de respuesta).
  const respondidos3m = orders.filter((o) => {
    const respondedAt = o.accepted_at || o.rejected_at;
    return respondedAt && inLast3(respondedAt) && o.created_at;
  });
  const respuestaAvg = respondidos3m.length > 0
    ? avg(respondidos3m.map((o) => {
        const respondedAt = o.accepted_at || o.rejected_at;
        return (new Date(respondedAt) - new Date(o.created_at)) / 86400000;
      })) : null;
  const respuestaCount = respondidos3m.length;

  const lotsDeliveredMes = lots.filter((l) =>
    l.status === 'Delivered' && (l.delivered_date || '').slice(0, 7) === thisMonth).length;

  const creadosMes = orders.filter((o) => (o.created_at || '').slice(0, 7) === thisMonth).length;
  const creadosMesPrev = orders.filter((o) => (o.created_at || '').slice(0, 7) === lastMonth).length;
  const creadosDelta = creadosMesPrev > 0
    ? ((creadosMes - creadosMesPrev) / creadosMesPrev) * 100 : null;

  // Trend mensual: últimos 12 meses
  const trendMonths = [];
  for (let i = 11; i >= 0; i--) trendMonths.push(monthOffset(todayDate, -i));
  const trendMonthly = trendMonths.map((mes) => {
    const created = orders.filter((o) => (o.created_at || '').slice(0, 7) === mes);
    const accepted = orders.filter((o) => (o.accepted_at || '').slice(0, 7) === mes);
    return {
      mes,
      solicitado: sum(created,  (o) => o.kg_green_required),
      aceptado:   sum(accepted, (o) => o.kg_green_accepted),
      despachado: sum(
        shipments.filter((s) => (s.shipment_date || '').slice(0, 7) === mes),
        (s) => s.totals?.kg_green || 0,
      ),
    };
  });

  // Pipeline kg
  const pipelineKg = {
    InFermentation: sum(activeLots.filter((l) => l.status === 'InFermentation'),
      (l) => l.kg_green_actual ?? l.kg_green_expected ?? 0),
    Drying: sum(activeLots.filter((l) => l.status === 'Drying'),
      (l) => l.kg_green_actual ?? l.kg_green_expected ?? 0),
    Ready: sum(activeLots.filter((l) => l.status === 'Ready'),
      (l) => l.kg_green_actual ?? l.kg_green_expected ?? 0),
  };

  // Distribución por proceso (últimos 6 meses, kg despachado)
  const last6 = [];
  for (let i = 5; i >= 0; i--) last6.push(monthOffset(todayDate, -i));
  const recentShips = shipments.filter((s) =>
    last6.includes((s.shipment_date || '').slice(0, 7)));
  const kgByProcess6m = { Natural: 0, Honey: 0, Lavado: 0 };
  for (const s of recentShips) {
    for (const lot of s.lots || []) {
      const kg = Number(lot.kg_green_in_shipment ?? lot.kg_green_actual ?? 0);
      if (lot.process_type && kgByProcess6m[lot.process_type] != null) {
        kgByProcess6m[lot.process_type] += kg;
      }
    }
  }

  // Despachos recientes (top 20, ya viene ordenado desc por fecha)
  const recentShipments = shipments.slice(0, 20);

  return {
    kgDespTotal, kgDespMes, kgDespMomDelta,
    lotsActivos, lotsReady, lotsDrying, lotsFerm,
    pedidosEnCurso, pedidosPending,
    kgSinAsignar, pedidosSinLote,
    fermentacionVencida, dryingVencido, listosSinDespachar,
    cumplimientoRate, cumplimientoTotal: completed3m.length,
    acceptanceRate, acceptanceCreated: created3m.length,
    factorByProcess,
    rejected3mCount, rejected3mKg,
    cycleAvg, cycleCount, respuestaAvg, respuestaCount,
    lotsDeliveredMes, creadosMes, creadosDelta,
    trendMonthly, pipelineKg, kgByProcess6m, recentShipments,
  };
}

// ─── Charts ─────────────────────────────────────────────────────────
function trendChart(rows) {
  const maxKg = Math.max(1, ...rows.flatMap((r) => [r.solicitado, r.aceptado, r.despachado]));
  const chart = el('div', { class: 'ctrm-card ctrm-card-pad' }, [
    el('div', { class: 'flex items-end gap-1 h-44 overflow-x-auto' },
      rows.map((r) => trendBarGroup(r, maxKg))),
    el('div', { class: 'flex items-center justify-center gap-3 mt-3 text-[10px] text-ink-500' }, [
      legendDot('#7e9ec1', 'Solicitado'),
      legendDot('#ddae3e', 'Aceptado'),
      legendDot('#5d8b66', 'Despachado'),
    ]),
  ]);
  return chart;
}

function trendBarGroup(r, maxKg) {
  const h = (kg) => `${Math.max(2, (kg / maxKg) * 100)}%`;
  return el('div', { class: 'flex flex-col items-center gap-1 shrink-0', style: 'min-width:36px;' }, [
    el('div', { class: 'flex items-end gap-0.5 h-36' }, [
      el('div', {
        class: 'w-2 rounded-t-sm',
        style: `height:${h(r.solicitado)};background:#7e9ec1;`,
        title: `${r.mes} solicitado: ${fmtKg(r.solicitado)}`,
      }),
      el('div', {
        class: 'w-2 rounded-t-sm',
        style: `height:${h(r.aceptado)};background:#ddae3e;`,
        title: `${r.mes} aceptado: ${fmtKg(r.aceptado)}`,
      }),
      el('div', {
        class: 'w-2 rounded-t-sm',
        style: `height:${h(r.despachado)};background:#5d8b66;`,
        title: `${r.mes} despachado: ${fmtKg(r.despachado)}`,
      }),
    ]),
    el('div', { class: 'text-[9px] text-ink-300 font-mono', style: 'transform:rotate(-45deg);' },
      [r.mes.slice(2)]),
  ]);
}

function pipelineBar(p) {
  const total = p.InFermentation + p.Drying + p.Ready;
  const segs = [
    { key: 'InFermentation', kg: p.InFermentation, color: STAGE_COLORS.InFermentation, label: 'Fermentación' },
    { key: 'Drying',         kg: p.Drying,         color: STAGE_COLORS.Drying,         label: 'Drying' },
    { key: 'Ready',          kg: p.Ready,          color: STAGE_COLORS.Ready,          label: 'Ready' },
  ];
  return el('div', { class: 'ctrm-card ctrm-card-pad space-y-3' }, [
    el('div', { class: 'flex h-6 rounded-md overflow-hidden bg-sand' },
      total > 0
        ? segs.filter((s) => s.kg > 0).map((s) => el('div', {
            class: 'h-full',
            style: `flex:${s.kg} 0 0;background:${s.color};`,
            title: `${s.label}: ${fmtKg(s.kg)}`,
          }))
        : []),
    el('div', { class: 'grid grid-cols-3 gap-2' }, segs.map((s) =>
      el('div', { class: 'rounded-md p-2 border border-sand' }, [
        el('div', { class: 'flex items-center gap-1.5 mb-1' }, [
          el('span', { class: 'inline-block w-2 h-2 rounded-sm', style: `background:${s.color};` }),
          el('span', { class: 'text-[11px] text-ink-500', text: s.label }),
        ]),
        el('p', { class: 'text-[14px] font-display font-semibold text-navy font-mono', text: fmtKg(s.kg) }),
        el('p', { class: 'text-[10px] text-ink-300', text: total > 0 ? `${((s.kg / total) * 100).toFixed(0)}%` : '—' }),
      ]),
    )),
    total === 0
      ? el('p', { class: 'text-[12px] text-ink-300 italic text-center', text: 'Sin lotes activos.' })
      : null,
  ]);
}

function processDonut(byProc) {
  const total = (byProc.Natural || 0) + (byProc.Honey || 0) + (byProc.Lavado || 0);
  const card = el('div', { class: 'ctrm-card ctrm-card-pad' });
  if (total === 0) {
    card.append(el('p', { class: 'text-[12px] text-ink-300 italic text-center py-6',
      text: 'Sin despachos en los últimos 6 meses.' }));
    return card;
  }
  let acc = 0;
  const stops = [];
  for (const p of PROCESSES) {
    const v = byProc[p] || 0;
    if (v <= 0) continue;
    const start = (acc / total) * 360;
    acc += v;
    const end = (acc / total) * 360;
    stops.push(`${PROC_COLORS[p]} ${start}deg ${end}deg`);
  }
  const conic = stops.join(', ');
  card.append(el('div', { class: 'flex flex-col sm:flex-row items-center gap-6' }, [
    el('div', {
      class: 'rounded-full shrink-0',
      style: `width:160px;height:160px;background:conic-gradient(${conic});` +
             `mask:radial-gradient(circle 50px at center, transparent 99%, #000 100%);` +
             `-webkit-mask:radial-gradient(circle 50px at center, transparent 99%, #000 100%);`,
    }),
    el('div', { class: 'flex-1 w-full space-y-1.5' }, PROCESSES.map((p) => {
      const v = byProc[p] || 0;
      const pct = (v / total) * 100;
      return el('div', { class: 'flex items-center gap-2' }, [
        el('span', { class: 'inline-block w-3 h-3 rounded-sm shrink-0', style: `background:${PROC_COLORS[p]};` }),
        el('span', { class: 'text-[12px] text-ink-700 w-20', text: p }),
        el('div', { class: 'flex-1 h-1.5 rounded-full bg-sand overflow-hidden' }, [
          el('div', { class: 'h-full', style: `width:${pct}%;background:${PROC_COLORS[p]};` }),
        ]),
        el('span', { class: 'text-[11px] font-mono text-ink-700 w-24 text-right' }, [
          fmtKg(v), el('span', { class: 'text-ink-300', text: ` ${pct.toFixed(0)}%` }),
        ]),
      ]);
    })),
  ]));
  return card;
}

function recentShipmentsTable(ships) {
  if (ships.length === 0) {
    return el('div', { class: 'ctrm-card ctrm-card-pad' }, [
      el('p', { class: 'text-[12px] text-ink-300 italic', text: 'Aún no se han creado despachos.' }),
    ]);
  }
  const wrap = el('div', { class: 'ctrm-card overflow-x-auto' });
  const t = el('table', { class: 'w-full text-[12px]' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', {}, ['Código']),
      el('th', {}, ['Fecha']),
      el('th', { class: 'text-right' }, ['Lotes']),
      el('th', { class: 'text-right' }, ['Pedidos']),
      el('th', { class: 'text-right' }, ['kg verde']),
    ])]),
    el('tbody', {}, ships.map((s) => el('tr', {
      class: 'cursor-pointer hover:bg-cream',
      onClick: () => navigate('/finca/despachos'),
    }, [
      el('td', { class: 'font-mono text-navy font-semibold', text: s.shipment_code }),
      el('td', { class: 'font-mono', text: fmtDate(s.shipment_date) }),
      el('td', { class: 'text-right font-mono', text: String(s.totals?.lot_count ?? s.lots.length) }),
      el('td', { class: 'text-right font-mono', text: String(s.totals?.order_count ?? '—') }),
      el('td', { class: 'text-right font-mono font-bold text-navy', text: fmtKg(s.totals?.kg_green || 0) }),
    ]))),
  ]);
  wrap.append(t);
  return wrap;
}

// ─── UI helpers ─────────────────────────────────────────────────────
function sectionLabel(text) {
  return el('h3', { class: 'eyebrow mb-2 mt-4', text });
}

function statRow(items) {
  return el('div', { class: 'grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3' }, items);
}

function stat(label, value, hint, kind) {
  const valClass = kind ? `stat-val ${kind}` : 'stat-val';
  return el('div', { class: 'stat-card' }, [
    el('p', { class: 'stat-label', text: label }),
    el('p', { class: valClass, text: String(value) }),
    el('p', { class: 'stat-sub', text: hint }),
  ]);
}

function kpiCumplimiento(rate, total) {
  const kind = rate == null ? null : rate >= 90 ? 'ok' : rate >= 70 ? 'warn' : 'crit';
  return stat('Cumplimiento plazos 3m',
    rate != null ? `${rate.toFixed(0)}%` : '—',
    `${total} entregados c/fecha`, kind);
}

function kpiAceptacion(rate, total) {
  const kind = rate == null ? null : rate >= 90 ? 'ok' : rate >= 70 ? 'warn' : 'crit';
  return stat('Tasa aceptación 3m',
    rate != null ? `${rate.toFixed(0)}%` : '—',
    `${total} pedidos creados`, kind);
}

function factorByProcessCard(byProcess) {
  const rows = PROCESSES.map((p) => {
    const b = byProcess[p] || {};
    const right = b.avg != null
      ? el('span', {}, [
          el('strong', { class: 'text-ink-700 font-mono', text: b.avg.toFixed(2) }),
          el('span', { class: 'text-ink-300 text-[10px]', text: ` · ${b.month}` }),
        ])
      : el('span', { class: 'text-ink-300 font-mono', text: '—' });
    return el('div', { class: 'flex items-baseline justify-between text-[12px]' }, [
      el('span', { class: 'text-ink-500', text: p }),
      right,
    ]);
  });
  return el('div', { class: 'stat-card' }, [
    el('p', { class: 'stat-label', text: 'Factor reciente por proceso' }),
    el('div', { class: 'space-y-0.5 mt-1' }, rows),
    el('p', { class: 'stat-sub', text: 'Promedio del último mes con datos' }),
  ]);
}

function section(title, child) {
  return el('section', { class: 'mb-5 mt-5' }, [
    el('h3', { class: 'eyebrow mb-2', text: title }),
    child,
  ]);
}

function legendDot(color, label) {
  return el('span', { class: 'inline-flex items-center gap-1' }, [
    el('span', { class: 'inline-block w-2 h-2 rounded-sm', style: `background:${color};` }),
    label,
  ]);
}

function momHint(deltaPct) {
  if (deltaPct == null) return 'sin datos previos';
  return `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(0)}% vs mes prev.`;
}

// ─── Pure helpers ───────────────────────────────────────────────────
function sum(arr, getter) { return arr.reduce((s, x) => s + Number(getter(x) || 0), 0); }
function avg(arr) { return arr.length === 0 ? null : arr.reduce((s, x) => s + x, 0) / arr.length; }

function monthOffset(date, deltaMonths) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + deltaMonths);
  return d.toISOString().slice(0, 7);
}

function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return 0;
  const a = new Date(fromIso + 'T00:00:00Z');
  const b = new Date(toIso   + 'T00:00:00Z');
  return Math.floor((b - a) / 86400000);
}
