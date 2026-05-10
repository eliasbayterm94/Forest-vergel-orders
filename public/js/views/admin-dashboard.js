// Admin-only dashboard. Cross-cutting view — combina señales de
// comercial (Forest) y producción (Finca) que normalmente viven en
// vistas separadas, mas tres graficos (trend mensual, pipeline kg,
// distribución por proceso) y una tabla de despachos recientes.

import { el, clear } from '../ui/el.js';
import { createCombobox } from '../ui/combobox.js';
import { fmtKg, fmtDate, relTime } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { navigate, currentQuery, updateHashQuery } from '../router.js';

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
  const [ordersRes, lotsRes, shipsRes, leadRes, refsRes, auditRes, emailRes] = await Promise.all([
    api.ordersList({}),
    api.lotsList({}),
    api.shipmentsList(),
    api.processLeadTimes().catch(() => ({ process_lead_times: [] })),
    api.references().catch(() => ({ references: [] })),
    api.auditLog({ limit: 30 }).catch(() => ({ events: [] })),
    api.emailLog({ limit: 20 }).catch(() => ({ emails: [] })),
  ]);
  const today     = ordersRes.today;
  const allOrders = ordersRes.orders || [];
  const allLots   = lotsRes.lots || [];
  const allShips  = shipsRes.shipments || [];
  const refs      = refsRes.references || [];
  const auditEvents = auditRes.events || [];
  const emails = emailRes.emails || [];
  const leadByProcess = new Map(
    (leadRes.process_lead_times || []).map((r) => [r.process_type, r]),
  );

  // Estado inicial leido del hash (?range=24m&ref=xxx). Si la
  // referencia del hash ya no existe se resetea a null.
  const initialQ = currentQuery();
  const initialRange = RANGES.some((r) => r.key === initialQ.get('range'))
    ? initialQ.get('range') : DEFAULT_RANGE;
  const initialRef = initialQ.get('ref');
  const state = {
    range: initialRange,
    refId: initialRef && refs.some((r) => r.id === initialRef) ? initialRef : null,
  };

  const filterBar = renderFilterBar(state, refs, () => {
    updateHashQuery({
      range: state.range === DEFAULT_RANGE ? null : state.range,
      ref:   state.refId,
    });
    redraw();
  });
  const contentWrap = el('div', {});

  function redraw() {
    const filtered = applyFilters({ allOrders, allLots, allShips, state });
    const m = computeMetrics({
      ...filtered, today, leadByProcess, range: state.range,
    });
    clear(contentWrap);
    contentWrap.append(...renderSections(m, state, auditEvents, emails));
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
  const initialRefItem = state.refId
    ? refs.find((r) => r.id === state.refId) || null
    : null;
  const refCombo = createCombobox({
    placeholder: 'Filtrar por referencia...',
    items: refItems,
    value: initialRefItem,
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

  // Funnel acumulado del rango: solicitado → aceptado → despachado
  const createdInRange = orders.filter((o) => inRange(o.created_at));
  const acceptedInRange = orders.filter((o) => inRange(o.accepted_at));
  const funnelTotals = {
    solicitado: sum(createdInRange,  (o) => o.kg_green_required),
    aceptado:   sum(acceptedInRange, (o) => o.kg_green_accepted),
    despachado: sum(shipsInRange,    (s) => s.totals?.kg_green || 0),
    creadosCount:    createdInRange.length,
    aceptadosCount:  acceptedInRange.length,
    despachosCount:  shipsInRange.length,
  };

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
    funnelTotals, pipelineKg, kgByProcessRange, recentShipments,
  };
}

// ─── Sections render ────────────────────────────────────────────────
function renderSections(m, state, auditEvents = [], emails = []) {
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

    section(`Embudo · Solicitado → Aceptado → Despachado (${m.rangeLabel})`,
      funnelChart(m.funnelTotals)),

    section('Pipeline · kg verde por etapa', pipelineBar(m.pipelineKg)),

    section(`Distribución por proceso · kg verde despachado en ${m.rangeLabel}`,
      processDonut(m.kgByProcessRange)),

    section(`Despachos recientes · ${m.rangeLabel}`,
      recentShipmentsTable(m.recentShipments)),

    auditEvents.length > 0
      ? section('Actividad reciente', auditFeed(auditEvents))
      : null,

    emails.length > 0
      ? section('Notificaciones enviadas (últimas 20)', emailFeed(emails))
      : null,
  ].filter(Boolean);
}

// ─── Email log feed ─────────────────────────────────────────────────
const EVENT_TYPE_LABELS = {
  demand_created:    'Pedido creado',
  daily_new_orders:  'Resumen diario de pedidos',
  demand_accepted:   'Pedido aceptado',
  demand_rejected:   'Pedido rechazado',
  order_completed:   'Pedido completado',
  weekly_digest:     'Resumen semanal',
};
const EMAIL_STATUS_KIND = { sent: 'ok', dry_run: 'muted', failed: 'crit' };
const EMAIL_STATUS_LABEL = { sent: 'Enviado', dry_run: 'Dry-run', failed: 'Fallido' };

function emailFeed(emails) {
  return el('div', { class: 'ctrm-card overflow-hidden' },
    emails.map((e) => el('div', {
      class: 'flex items-start gap-3 px-3 py-2 border-b border-sand last:border-b-0',
    }, [
      el('div', { class: 'shrink-0 text-[10px] font-mono text-ink-300 w-20', text: relTime(e.sent_at) }),
      el('span', {
        class: `ctrm-pill ${EMAIL_STATUS_KIND[e.status] || 'muted'}`,
        style: 'flex-shrink:0;',
        text: EMAIL_STATUS_LABEL[e.status] || e.status,
      }),
      el('div', { class: 'flex-1 min-w-0' }, [
        el('div', { class: 'flex items-baseline gap-2 flex-wrap' }, [
          el('span', { class: 'text-[12px] font-display font-semibold text-navy', text: EVENT_TYPE_LABELS[e.event_type] || e.event_type }),
          el('span', { class: 'text-[10px] text-ink-300', text: e.to_address }),
        ]),
        el('p', { class: 'text-[11px] text-ink-700 truncate', text: e.subject }),
        e.error_message
          ? el('p', { class: 'text-[10px] font-mono text-crit mt-0.5', text: e.error_message })
          : null,
      ]),
    ])));
}

// ─── Audit feed ─────────────────────────────────────────────────────
const ENTITY_LABELS = {
  demand_orders:         'Pedido',
  production_lots:       'Lote',
  lot_partials:          'Parcial',
  lot_order_assignments: 'Asignación',
  shipments:             'Despacho',
  shipment_lots:         'Despacho-lote',
};
const ACTION_LABELS = { INSERT: 'Creado', UPDATE: 'Editado', DELETE: 'Borrado' };
const ACTION_KIND   = { INSERT: 'ok',     UPDATE: 'muted',   DELETE: 'crit' };
// Claves que no aportan al diff humano. Se ocultan del resumen pero
// el evento sigue siendo visible.
const HIDE_FIELDS = new Set([
  'id', 'created_at', 'updated_at',
  'in_production_at', 'accepted_at', 'rejected_at', 'completed_at',
  'cancelled_at', 'delivered_date', 'ready_date', 'drying_start_date',
]);

function auditFeed(events) {
  return el('div', { class: 'ctrm-card overflow-hidden' },
    events.map(eventRow));
}

function eventRow(e) {
  const label  = ENTITY_LABELS[e.entity_type] || e.entity_type;
  const action = ACTION_LABELS[e.action] || e.action;
  const kind   = ACTION_KIND[e.action] || 'muted';
  const after  = (e.changed_fields || {});
  const codeAfter = (after.order_code || after.bache_code || after.shipment_code || [])[1];
  const lotCodeAfter = (after.lot_code || [])[1];
  const codeFromInsert = codeAfter || lotCodeAfter || '';

  // Filtra solo cambios "interesantes" para el resumen. Para INSERT
  // mostramos un resumen super corto; para UPDATE listamos los campos
  // cambiados con before → after.
  const summary = formatSummary(e, after);

  return el('div', {
    class: 'flex items-start gap-3 px-3 py-2 border-b border-sand last:border-b-0',
  }, [
    el('div', { class: 'shrink-0 text-[10px] font-mono text-ink-300 w-20', text: relTime(e.at) }),
    el('span', { class: `ctrm-pill ${kind}`, style: 'flex-shrink:0;', text: action }),
    el('div', { class: 'flex-1 min-w-0' }, [
      el('div', { class: 'flex items-baseline gap-2 flex-wrap' }, [
        el('span', { class: 'text-[12px] font-display font-semibold text-navy', text: label }),
        codeFromInsert
          ? el('span', { class: 'ctrm-code text-[10px]', text: String(codeFromInsert) })
          : null,
        e.actor
          ? el('span', { class: 'text-[10px] text-ink-300 uppercase tracking-loose', text: `por ${e.actor}` })
          : null,
      ]),
      summary
        ? el('p', { class: 'text-[11px] font-mono text-ink-500 mt-0.5', text: summary })
        : null,
    ]),
  ]);
}

function formatSummary(e, after) {
  const entries = Object.entries(after).filter(([k]) => !HIDE_FIELDS.has(k));
  if (entries.length === 0) return null;

  if (e.action === 'INSERT') {
    // Resumen breve de campos clave si existen.
    const keys = ['kg_green_required', 'kg_green_accepted', 'reference_id',
                  'process_type', 'status', 'kg_dried', 'parcial_letter',
                  'kg_green_allocated', 'shipment_date'];
    const parts = [];
    for (const k of keys) {
      const v = after[k];
      if (v == null) continue;
      const val = Array.isArray(v) ? v[1] : v;
      if (val == null || val === '') continue;
      parts.push(`${k}=${formatVal(val)}`);
      if (parts.length >= 4) break;
    }
    return parts.length > 0 ? parts.join(' · ') : null;
  }

  if (e.action === 'DELETE') {
    return 'Registro eliminado';
  }

  // UPDATE: lista compacta key: before → after
  const parts = entries.slice(0, 5).map(([k, [before, after]]) =>
    `${k}: ${formatVal(before)} → ${formatVal(after)}`);
  if (entries.length > 5) parts.push(`y ${entries.length - 5} más`);
  return parts.join(' · ');
}

function formatVal(v) {
  if (v == null) return '∅';
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === 'object') return '{…}';
  if (typeof v === 'string' && v.length > 24) return v.slice(0, 24) + '…';
  return String(v);
}


// ─── Charts ─────────────────────────────────────────────────────────
function funnelChart(t) {
  // Embudo cuantitativo del rango. La barra de cada etapa se mide
  // contra la siguiente etapa hacia atras (Solicitado=100%, Aceptado=
  // % del solicitado, Despachado=% del aceptado). Entre etapas se
  // muestra el "drop-off" en kg y porcentaje.
  const stages = [
    { key: 'solicitado', label: 'Solicitado', value: t.solicitado, count: t.creadosCount,
      sub: 'Pedidos creados',  color: TREND_COLORS.solicitado },
    { key: 'aceptado',   label: 'Aceptado',   value: t.aceptado,   count: t.aceptadosCount,
      sub: 'Pedidos aceptados', color: TREND_COLORS.aceptado },
    { key: 'despachado', label: 'Despachado', value: t.despachado, count: t.despachosCount,
      sub: 'Despachos creados', color: TREND_COLORS.despachado },
  ];
  const max = Math.max(t.solicitado, 1);

  if (t.solicitado === 0 && t.aceptado === 0 && t.despachado === 0) {
    return el('div', { class: 'ctrm-card ctrm-card-pad' }, [
      el('p', { class: 'text-[12px] text-ink-300 italic text-center py-4',
        text: 'Sin actividad en este rango.' }),
    ]);
  }

  const children = [];
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const pctOfMax = max > 0 ? (s.value / max) * 100 : 0;
    const prev = i > 0 ? stages[i - 1] : null;
    const conv = prev && prev.value > 0 ? (s.value / prev.value) * 100 : null;

    if (i > 0) {
      const dropKg = Math.max(0, prev.value - s.value);
      const dropPct = prev.value > 0 ? (dropKg / prev.value) * 100 : 0;
      children.push(el('div', {
        class: 'flex items-center gap-2 pl-3 my-1 text-[11px] font-mono text-ink-300',
      }, [
        el('span', { text: '↓' }),
        dropKg > 0.001
          ? el('span', { class: 'text-warn' }, [
              `−${fmtKg(dropKg)}`,
              el('span', { class: 'text-ink-300', text: ` (${dropPct.toFixed(0)}% drop)` }),
            ])
          : el('span', { class: 'text-ok', text: 'sin drop' }),
      ]));
    }

    children.push(el('div', { class: 'space-y-1' }, [
      el('div', { class: 'flex items-baseline justify-between gap-2 flex-wrap' }, [
        el('div', { class: 'flex items-baseline gap-2' }, [
          el('span', { class: 'inline-block w-2 h-2 rounded-sm', style: `background:${s.color};` }),
          el('span', { class: 'text-[12px] font-display font-semibold text-navy', text: s.label }),
          el('span', { class: 'text-[10px] text-ink-300 uppercase tracking-loose', text: s.sub }),
        ]),
        el('div', { class: 'flex items-baseline gap-2' }, [
          el('strong', { class: 'font-mono text-ink-700', text: fmtKg(s.value) }),
          el('span', { class: 'text-[10px] text-ink-300 font-mono', text: `${s.count} pedido(s)` }),
          conv != null
            ? el('span', { class: 'text-[11px] font-mono text-ink-500',
                text: `${conv.toFixed(0)}% del anterior` })
            : el('span', { class: 'text-[11px] font-mono text-ok', text: '100%' }),
        ]),
      ]),
      el('div', { class: 'h-5 rounded-md bg-sand overflow-hidden' }, [
        el('div', {
          class: 'h-full',
          style: `width:${pctOfMax}%;background:${s.color};`,
          title: `${s.label}: ${fmtKg(s.value)}`,
        }),
      ]),
    ]));
  }

  // Conversión total (despachado / solicitado)
  const totalConv = t.solicitado > 0 ? (t.despachado / t.solicitado) * 100 : null;
  if (totalConv != null) {
    children.push(el('div', {
      class: 'mt-3 pt-3 border-t border-sand flex items-center justify-between text-[12px]',
    }, [
      el('span', { class: 'eyebrow', text: 'Conversión total' }),
      el('strong', {
        class: `font-mono ${totalConv >= 70 ? 'text-ok' : totalConv >= 40 ? 'text-warn' : 'text-crit'}`,
        text: `${totalConv.toFixed(0)}%`,
      }),
    ]));
  }

  return el('div', { class: 'ctrm-card ctrm-card-pad' }, children);
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
  const cell = (label, classes, text) => {
    const td = el('td', { class: classes, text });
    td.setAttribute('data-label', label);
    return td;
  };
  const t = el('table', { class: 'w-full text-[12px] responsive-stack' }, [
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
      cell('Código',  'font-mono text-navy font-semibold', s.shipment_code),
      cell('Fecha',   'font-mono', fmtDate(s.shipment_date)),
      cell('Lotes',   'text-right font-mono', String(s.totals?.lot_count ?? s.lots.length)),
      cell('Pedidos', 'text-right font-mono', String(s.totals?.order_count ?? '—')),
      cell('kg verde', 'text-right font-mono font-bold text-navy', fmtKg(s.totals?.kg_green || 0)),
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
