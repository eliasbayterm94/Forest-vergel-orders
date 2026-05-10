// Admin-only dashboard. Cross-cutting view — combina señales de
// comercial (Forest) y producción (Finca) que normalmente viven en
// vistas separadas, mas tres graficos (trend mensual, pipeline kg,
// distribución por proceso) y una tabla de despachos recientes.

import { el, clear } from '../ui/el.js';
import { createCombobox } from '../ui/combobox.js';
import { fmtKg, fmtDate } from '../ui/format.js';
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
const TREND_COLORS = {
  solicitado: '#7e9ec1',
  aceptado:   '#ddae3e',
  despachado: '#5d8b66',
};

const RANGES = [
  { key: '3m',  label: '3 m',   months: 3  },
  { key: '6m',  label: '6 m',   months: 6  },
  { key: '12m', label: '12 m',  months: 12 },
  { key: '24m', label: '24 m',  months: 24 },
];
const DEFAULT_RANGE = '12m';

export async function adminDashboardView() {
  const [ordersRes, lotsRes, shipsRes, leadRes, refsRes] = await Promise.all([
    api.ordersList({}),
    api.lotsList({}),
    api.shipmentsList(),
    api.processLeadTimes().catch(() => ({ process_lead_times: [] })),
    api.references().catch(() => ({ references: [] })),
  ]);
  const today     = ordersRes.today;
  const allOrders = ordersRes.orders || [];
  const allLots   = lotsRes.lots || [];
  const allShips  = shipsRes.shipments || [];
  const refs      = refsRes.references || [];
  const leadByProcess = new Map(
    (leadRes.process_lead_times || []).map((r) => [r.process_type, r]),
  );

  const state = {
    range: DEFAULT_RANGE,
    refId: null,        // null = todas
  };

  const filterBar = renderFilterBar(state, refs, () => redraw());
  const contentWrap = el('div', {});

  function redraw() {
    const filtered = applyFilters({ allOrders, allLots, allShips, state });
    const m = computeMetrics({
      ...filtered, today, leadByProcess, range: state.range,
    });
    clear(contentWrap);
    contentWrap.append(...renderSections(m, state));
    filterBar.refresh();
  }
  redraw();

  return chrome(el('div', {}, [
    pageTitle('Dashboard admin', `Hoy: ${today}`),
    filterBar.el,
    contentWrap,
  ]));
}

// ─── Filter bar ─────────────────────────────────────────────────────
function renderFilterBar(state, refs, onChange) {
  const rangeButtons = RANGES.map((r) => el('button', {
    type: 'button',
    class: 'ctrm-btn ctrm-btn-sm',
    'data-range': r.key,
    onClick: () => { state.range = r.key; onChange(); },
  }, [r.label]));

  const refItems = [{ id: '__all__', name: 'Todas las referencias' }, ...refs];
  const refCombo = createCombobox({
    placeholder: 'Filtrar por referencia...',
    items: refItems,
    onChange: (item) => {
      state.refId = (!item || item.id === '__all__') ? null : item.id;
      onChange();
    },
  });

  const wrap = el('div', {
    class: 'ctrm-card ctrm-card-pad mb-4 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3',
  }, [
    el('div', {}, [
      el('label', { class: 'ctrm-label', text: 'Referencia' }),
      refCombo.el,
    ]),
    el('div', {}, [
      el('label', { class: 'ctrm-label', text: 'Rango' }),
      el('div', { class: 'flex flex-wrap gap-1' }, rangeButtons),
    ]),
  ]);

  function refresh() {
    for (const b of rangeButtons) {
      const isActive = b.getAttribute('data-range') === state.range;
      b.className = isActive
        ? 'ctrm-btn ctrm-btn-primary ctrm-btn-sm'
        : 'ctrm-btn ctrm-btn-soft ctrm-btn-sm';
    }
  }
  refresh();

  return { el: wrap, refresh };
}

function applyFilters({ allOrders, allLots, allShips, state }) {
  if (state.refId == null) {
    return { orders: allOrders, lots: allLots, shipments: allShips };
  }
  const orders = allOrders.filter((o) => o.reference_id === state.refId);
  const lots = allLots.filter((l) => l.reference_id === state.refId);
  // Un despacho entra si AL MENOS UN lote del despacho es de la referencia
  // filtrada. Las metricas de kg luego suman solo lo de esa referencia.
  const shipments = allShips
    .filter((s) => (s.lots || []).some((l) => l.id && lots.some((x) => x.id === l.id)))
    .map((s) => {
      const lotsHere = (s.lots || []).filter((l) => lots.some((x) => x.id === l.id));
      const kg = lotsHere.reduce((acc, l) => acc + Number(l.kg_green_in_shipment ?? l.kg_green_actual ?? 0), 0);
      return {
        ...s,
        lots: lotsHere,
        totals: {
          ...(s.totals || {}),
          kg_green: kg,
          lot_count: lotsHere.length,
        },
      };
    });
  return { orders, lots, shipments };
}

// ─── Metrics computation ────────────────────────────────────────────
function computeMetrics({ orders, lots, shipments, today, leadByProcess, range }) {
  const todayDate = new Date(today + 'T12:00:00Z');
  const thisMonth = today.slice(0, 7);
  const lastMonth = monthOffset(todayDate, -1);

  const r = RANGES.find((x) => x.key === range) || RANGES[2];
  const months = [];
  for (let i = r.months - 1; i >= 0; i--) months.push(monthOffset(todayDate, -i));
  const monthSet = new Set(months);
  const inRange = (s) => monthSet.has((s || '').slice(0, 7));

  // Operativos
  const shipsInRange = shipments.filter((s) => inRange(s.shipment_date));
  const kgDespRange = sum(shipsInRange, (s) => s.totals?.kg_green || 0);
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

  const inFlight = orders.filter((o) =>
    ['Accepted','PartiallyAccepted','InProduction'].includes(o.status));
  const pedidosEnCurso = inFlight.length;
  const pedidosPending = orders.filter((o) => o.status === 'Pending').length;

  // Estado de produccion (current state, no afectado por rango)
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

  // Calidad / cumplimiento (en rango)
  const completedRange = orders.filter((o) =>
    o.completed_at && inRange(o.completed_at) && o.max_delivery_date);
  const onTimeRange = completedRange.filter((o) =>
    (o.completed_at || '').slice(0, 10) <= o.max_delivery_date);
  const cumplimientoRate = completedRange.length > 0
    ? (onTimeRange.length / completedRange.length) * 100 : null;

  const createdRange = orders.filter((o) => inRange(o.created_at));
  const acceptedRange = createdRange.filter((o) =>
    ['Accepted','PartiallyAccepted','InProduction','Completed'].includes(o.status));
  const acceptanceRate = createdRange.length > 0
    ? (acceptedRange.length / createdRange.length) * 100 : null;

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

  let rejectedRangeCount = 0;
  let rejectedRangeKg = 0;
  for (const lot of lots) {
    for (const p of lot.partials || []) {
      if (!p.rejected_at) continue;
      if (!inRange(p.rejected_at)) continue;
      rejectedRangeCount += 1;
      rejectedRangeKg += Number(p.kg_green_yield || 0);
    }
  }

  // Velocidad / ritmo (en rango)
  const completedAllRange = orders.filter((o) =>
    o.completed_at && inRange(o.completed_at) && o.created_at);
  const cycleAvg = completedAllRange.length > 0
    ? avg(completedAllRange.map((o) =>
        (new Date(o.completed_at) - new Date(o.created_at)) / 86400000)) : null;

  const respondidos = orders.filter((o) => {
    const respondedAt = o.accepted_at || o.rejected_at;
    return respondedAt && inRange(respondedAt) && o.created_at;
  });
  const respuestaAvg = respondidos.length > 0
    ? avg(respondidos.map((o) => {
        const respondedAt = o.accepted_at || o.rejected_at;
        return (new Date(respondedAt) - new Date(o.created_at)) / 86400000;
      })) : null;

  const lotsDeliveredMes = lots.filter((l) =>
    l.status === 'Delivered' && (l.delivered_date || '').slice(0, 7) === thisMonth).length;

  const creadosMes = orders.filter((o) => (o.created_at || '').slice(0, 7) === thisMonth).length;
  const creadosMesPrev = orders.filter((o) => (o.created_at || '').slice(0, 7) === lastMonth).length;
  const creadosDelta = creadosMesPrev > 0
    ? ((creadosMes - creadosMesPrev) / creadosMesPrev) * 100 : null;

  // Trend chart: usa el rango activo
  const trendMonthly = months.map((mes) => {
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

  const pipelineKg = {
    InFermentation: sum(activeLots.filter((l) => l.status === 'InFermentation'),
      (l) => l.kg_green_actual ?? l.kg_green_expected ?? 0),
    Drying: sum(activeLots.filter((l) => l.status === 'Drying'),
      (l) => l.kg_green_actual ?? l.kg_green_expected ?? 0),
    Ready: sum(activeLots.filter((l) => l.status === 'Ready'),
      (l) => l.kg_green_actual ?? l.kg_green_expected ?? 0),
  };

  // Distribucion por proceso usa el rango activo (despachado)
  const kgByProcessRange = { Natural: 0, Honey: 0, Lavado: 0 };
  for (const s of shipsInRange) {
    for (const lot of s.lots || []) {
      const kg = Number(lot.kg_green_in_shipment ?? lot.kg_green_actual ?? 0);
      if (lot.process_type && kgByProcessRange[lot.process_type] != null) {
        kgByProcessRange[lot.process_type] += kg;
      }
    }
  }

  const recentShipments = shipsInRange.slice(0, 20);

  return {
    rangeMonths: r.months, rangeLabel: r.label,
    kgDespRange, kgDespMes, kgDespMomDelta,
    lotsActivos, lotsReady, lotsDrying,
    pedidosEnCurso, pedidosPending,
    kgSinAsignar, pedidosSinLote,
    fermentacionVencida, dryingVencido, listosSinDespachar,
    cumplimientoRate, cumplimientoTotal: completedRange.length,
    acceptanceRate, acceptanceCreated: createdRange.length,
    factorByProcess,
    rejectedRangeCount, rejectedRangeKg,
    cycleAvg, cycleCount: completedAllRange.length,
    respuestaAvg, respuestaCount: respondidos.length,
    lotsDeliveredMes, creadosMes, creadosDelta,
    trendMonthly, pipelineKg, kgByProcessRange, recentShipments,
  };
}

// ─── Sections render ────────────────────────────────────────────────
function renderSections(m, state) {
  const refLabel = state.refId == null ? '' : ' · referencia filtrada';
  const rangeWord = `${m.rangeLabel}${refLabel}`;

  return [
    sectionLabel('Operativos'),
    statRow([
      stat(`kg verde despachado · ${m.rangeLabel}`, fmtKg(m.kgDespRange),
        `${m.recentShipments.length} despacho(s) en rango`),
      stat('kg verde despachado mes', fmtKg(m.kgDespMes), momHint(m.kgDespMomDelta)),
      stat('Lotes activos', String(m.lotsActivos), `${m.lotsReady} Ready · ${m.lotsDrying} Drying`),
      stat('Pedidos en curso', String(m.pedidosEnCurso), `${m.pedidosPending} pendientes`),
    ]),

    sectionLabel('Estado de producción'),
    statRow([
      stat('kg verde sin asignar', fmtKg(m.kgSinAsignar),
        `${m.pedidosSinLote} pedidos sin lote`,
        m.kgSinAsignar > 0 ? 'warn' : 'ok'),
      stat('Fermentación vencida', String(m.fermentacionVencida),
        `>${FERMENTATION_OVERRUN_DAYS}d en fermentación`,
        m.fermentacionVencida > 0 ? 'crit' : 'ok'),
      stat('Drying vencido', String(m.dryingVencido), 'Excede días esperados',
        m.dryingVencido > 0 ? 'crit' : 'ok'),
      stat('Listos sin despachar', String(m.listosSinDespachar), 'Lotes Ready'),
    ]),

    sectionLabel(`Calidad / cumplimiento · ${rangeWord}`),
    statRow([
      kpiCumplimiento(m.cumplimientoRate, m.cumplimientoTotal),
      kpiAceptacion(m.acceptanceRate, m.acceptanceCreated),
      factorByProcessCard(m.factorByProcess),
      stat('Parciales rechazados',
        String(m.rejectedRangeCount),
        `${fmtKg(m.rejectedRangeKg)} verde perdido`,
        m.rejectedRangeCount > 0 ? 'warn' : null),
    ]),

    sectionLabel(`Velocidad / ritmo · ${rangeWord}`),
    statRow([
      stat('Tiempo de ciclo',
        m.cycleAvg != null ? `${m.cycleAvg.toFixed(1)} d` : '—',
        `${m.cycleCount} pedidos completados`),
      stat('Respuesta finca',
        m.respuestaAvg != null ? `${m.respuestaAvg.toFixed(1)} d` : '—',
        `${m.respuestaCount} pedidos respondidos`),
      stat('Lotes entregados mes', String(m.lotsDeliveredMes), 'Status Delivered'),
      stat('Pedidos creados mes', String(m.creadosMes), momHint(m.creadosDelta)),
    ]),

    section(`Trend · kg verde por mes (últimos ${m.rangeMonths} meses)`,
      trendChart(m.trendMonthly)),

    section('Pipeline · kg verde por etapa', pipelineBar(m.pipelineKg)),

    section(`Distribución por proceso · kg verde despachado en ${m.rangeLabel}`,
      processDonut(m.kgByProcessRange)),

    section(`Despachos recientes · ${m.rangeLabel}`,
      recentShipmentsTable(m.recentShipments)),
  ];
}

// ─── Charts ─────────────────────────────────────────────────────────
function trendChart(rows) {
  // SVG line chart con 3 series. Mejor que barras agrupadas cuando un
  // mes domina y los demas se ven casi planos.
  const W = 700, H = 240;
  const padL = 50, padR = 16, padT = 12, padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = rows.length;
  const maxKg = Math.max(1, ...rows.flatMap((r) => [r.solicitado, r.aceptado, r.despachado]));

  const x = (i) => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v) => padT + innerH - (v / maxKg) * innerH;

  // Grid + y-axis labels (5 niveles)
  const ticks = 4;
  const gridLines = [];
  const yLabels = [];
  for (let t = 0; t <= ticks; t++) {
    const v = (maxKg * t) / ticks;
    const yy = y(v);
    gridLines.push(svg('line', {
      x1: padL, x2: padL + innerW, y1: yy, y2: yy,
      stroke: '#e8e8e2', 'stroke-width': '1',
    }));
    yLabels.push(svg('text', {
      x: padL - 6, y: yy + 4,
      'text-anchor': 'end',
      'font-size': '10', 'font-family': 'monospace', fill: '#9aa3ae',
    }, [fmtKgShort(v)]));
  }

  // X labels (mes) — uno cada N pasos para no saturar
  const labelEvery = n <= 8 ? 1 : n <= 14 ? 2 : 3;
  const xLabels = rows.map((r, i) => {
    if (i % labelEvery !== 0 && i !== n - 1) return null;
    return svg('text', {
      x: x(i), y: H - padB + 16,
      'text-anchor': 'middle',
      'font-size': '10', 'font-family': 'monospace', fill: '#9aa3ae',
    }, [r.mes.slice(2)]);
  }).filter(Boolean);

  // Lineas + puntos
  const lineFor = (key) => {
    const d = rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(r[key])}`).join(' ');
    return svg('path', {
      d, fill: 'none',
      stroke: TREND_COLORS[key], 'stroke-width': '2',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    });
  };
  const dotsFor = (key) => rows.map((r, i) => svg('circle', {
    cx: x(i), cy: y(r[key]), r: '3',
    fill: TREND_COLORS[key], stroke: '#fff', 'stroke-width': '1',
  }, [
    svg('title', {}, [`${r.mes} · ${labelOf(key)}: ${fmtKg(r[key])}`]),
  ]));

  const chart = svg('svg', {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMid meet',
    style: 'width:100%;height:auto;display:block;',
  }, [
    ...gridLines, ...yLabels, ...xLabels,
    lineFor('solicitado'),
    lineFor('aceptado'),
    lineFor('despachado'),
    ...dotsFor('solicitado'),
    ...dotsFor('aceptado'),
    ...dotsFor('despachado'),
  ]);

  return el('div', { class: 'ctrm-card ctrm-card-pad' }, [
    chart,
    el('div', { class: 'flex items-center justify-center gap-3 mt-3 text-[10px] text-ink-500' }, [
      legendDot(TREND_COLORS.solicitado, 'Solicitado'),
      legendDot(TREND_COLORS.aceptado,   'Aceptado'),
      legendDot(TREND_COLORS.despachado, 'Despachado'),
    ]),
  ]);
}

function labelOf(key) {
  return { solicitado: 'Solicitado', aceptado: 'Aceptado', despachado: 'Despachado' }[key] || key;
}

function fmtKgShort(v) {
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  return Math.round(v).toString();
}

function pipelineBar(p) {
  const total = p.InFermentation + p.Drying + p.Ready;
  const segs = [
    { kg: p.InFermentation, color: STAGE_COLORS.InFermentation, label: 'Fermentación' },
    { kg: p.Drying,         color: STAGE_COLORS.Drying,         label: 'Drying' },
    { kg: p.Ready,          color: STAGE_COLORS.Ready,          label: 'Ready' },
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
      text: 'Sin despachos en este rango.' }));
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
      el('p', { class: 'text-[12px] text-ink-300 italic', text: 'Sin despachos en este rango.' }),
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
  return stat('Cumplimiento plazos',
    rate != null ? `${rate.toFixed(0)}%` : '—',
    `${total} entregados c/fecha`, kind);
}

function kpiAceptacion(rate, total) {
  const kind = rate == null ? null : rate >= 90 ? 'ok' : rate >= 70 ? 'warn' : 'crit';
  return stat('Tasa aceptación',
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

// ─── SVG helper ─────────────────────────────────────────────────────
function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null) continue;
    if (c instanceof Node) node.appendChild(c);
    else node.appendChild(document.createTextNode(String(c)));
  }
  return node;
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
