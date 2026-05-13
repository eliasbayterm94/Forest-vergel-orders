// Finca monitoring — alertas operativas + pipeline visual + operación
// en vivo (fermentación / drying) + tendencias semanales.
import { el, clear } from '../ui/el.js';
import { fmtKg, fmtDate, statusLabel, statusPillKind } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { navigate } from '../router.js';
import { renderFilterButton } from '../ui/filters-sheet.js';
import { createViewMode } from '../ui/view-mode.js';
import { createTabBar } from '../ui/tab-bar.js';

const STAGE_ORDER = ['InFermentation', 'Drying', 'Ready', 'Delivered'];

// Tolerancia (en dias) sobre los lead-times antes de marcar como vencido.
const FERMENTATION_OVERRUN_DAYS = 5;   // si el lote sigue InFermentation > 5d
const DRYING_GRACE_DAYS = 0;           // any day past drying_days is overrun

// Umbrales del tab Operación (semaforo en cards de lanes).
// Amarillo a partir del 80% del lead-time esperado; rojo cuando pasa.
const ALERT_AMBER_PCT = 0.8;
const DEFAULT_FERMENTATION_HOURS = 72;   // si el lote no trae fermentation_hours

export async function fincaMonitoreoView() {
  const [ordersRes, lotsRes, leadRes] = await Promise.all([
    api.ordersList({}),
    api.lotsList({}),
    api.processLeadTimes().catch(() => ({ process_lead_times: [] })),
  ]);

  const today  = ordersRes.today;
  const orders = ordersRes.orders || [];
  const lots   = lotsRes.lots || [];
  const leadByProcess = new Map(
    (leadRes.process_lead_times || []).map((r) => [r.process_type, r]),
  );

  // ── 1. Pedidos sin lote (o con lote insuficiente) ─────────────────
  const inFlight = orders.filter((o) =>
    ['Accepted', 'PartiallyAccepted', 'InProduction'].includes(o.status));
  const allocByOrder = new Map();
  for (const lot of lots) {
    // Incluir tambien Delivered: las kg de un lote despachado ya
    // cubrieron parte del pedido, no debe contar como "pendiente".
    for (const a of lot.assignments || []) {
      allocByOrder.set(a.demand_order_id,
        (allocByOrder.get(a.demand_order_id) || 0) + Number(a.kg_green_allocated || 0));
    }
  }
  const ordersSinLote = inFlight
    .map((o) => {
      const accepted  = Number(o.kg_green_accepted || 0);
      const allocated = allocByOrder.get(o.id) || 0;
      const pendiente = Math.max(0, accepted - allocated);
      return { ...o, allocated_kg: allocated, pendiente_kg: pendiente };
    })
    .filter((o) => o.pendiente_kg > 0.001)
    .sort((a, b) => (a.max_delivery_date || '').localeCompare(b.max_delivery_date || ''));

  // ── 2. Lotes con fermentacion vencida ─────────────────────────────
  const fermentationOverrun = lots
    .filter((l) => l.status === 'InFermentation')
    .map((l) => ({
      ...l,
      days_in_fermentation: daysBetween(l.start_date, today),
    }))
    .filter((l) => l.days_in_fermentation > FERMENTATION_OVERRUN_DAYS)
    .sort((a, b) => b.days_in_fermentation - a.days_in_fermentation);

  // ── 3. Lotes con drying vencido ──────────────────────────────────
  const dryingOverrun = lots
    .filter((l) => l.status === 'Drying' && l.drying_start_date)
    .map((l) => {
      const cfg = leadByProcess.get(l.process_type);
      const expected = cfg ? Number(cfg.drying_days) : null;
      const elapsed = daysBetween(l.drying_start_date, today);
      const over = expected != null ? elapsed - expected : null;
      return { ...l, drying_days_expected: expected, days_in_drying: elapsed, over_days: over };
    })
    .filter((l) => l.over_days != null && l.over_days > DRYING_GRACE_DAYS)
    .sort((a, b) => b.over_days - a.over_days);

  // ── Infusión map (order_id → Set<infusion_name>) ─────────────────
  const infusionsByOrder = new Map();
  for (const lot of lots) {
    if (!lot.infusion_name) continue;
    for (const a of lot.assignments || []) {
      if (!infusionsByOrder.has(a.demand_order_id)) infusionsByOrder.set(a.demand_order_id, new Set());
      infusionsByOrder.get(a.demand_order_id).add(lot.infusion_name);
    }
  }
  for (const o of ordersSinLote) {
    o.infusion_names = [...(infusionsByOrder.get(o.id) || [])];
  }
  const infusionOptions = [...new Set(lots.map((l) => l.infusion_name).filter(Boolean))].sort();

  // ── 4. Pipeline (count + kg verde por etapa) ─────────────────────
  const pipeline = {};
  for (const stage of STAGE_ORDER) pipeline[stage] = { count: 0, kg: 0 };
  for (const l of lots) {
    if (!pipeline[l.status]) continue;
    pipeline[l.status].count += 1;
    pipeline[l.status].kg    += Number(l.kg_green_actual ?? l.kg_green_expected ?? 0);
  }
  const maxCount = Math.max(1, ...STAGE_ORDER.map((s) => pipeline[s].count));
  const maxKg    = Math.max(1, ...STAGE_ORDER.map((s) => pipeline[s].kg));

  // ── Filtros (cliente solo aplica a pedidos; proceso a ambos) ──────
  let sheetValues = {};
  const sheetFilters = [
    { key: 'client_name', label: 'Cliente (pedidos)', multi: true,
      options: [...new Set(ordersSinLote.map((o) => o.client_name).filter(Boolean))].sort(),
      getter: (o) => o.client_name || '' },
    { key: 'process_type', label: 'Proceso', multi: true,
      options: ['Natural', 'Honey', 'Lavado'],
      getter: (o) => o.process_type || '' },
    { key: 'infusion', label: 'Infusión', multi: true,
      options: infusionOptions,
      getter: (o) => '' /* matching is custom — see passesOrder/passesLot */ },
  ];

  function passesOrder(o) {
    for (const f of sheetFilters) {
      const v = sheetValues[f.key];
      if (!v || v.length === 0) continue;
      if (f.key === 'infusion') {
        const set = infusionsByOrder.get(o.id) || new Set();
        if (!v.some((name) => set.has(name))) return false;
        continue;
      }
      if (!v.includes(f.getter(o))) return false;
    }
    return true;
  }
  function passesLot(l) {
    const proc = sheetValues.process_type;
    if (proc && proc.length > 0 && !proc.includes(l.process_type)) return false;
    const inf  = sheetValues.infusion;
    if (inf && inf.length > 0 && !inf.includes(l.infusion_name)) return false;
    return true;
  }

  // ── KPI row + secciones — todo en un wrapper que se redibuja ──────
  const root = el('div', {});
  const vm = createViewMode('finca-monitoreo', { onChange: () => redraw() });
  function listOrTable(items, kind) {
    if (items.length === 0) return null;
    if (vm.mode() === 'table') {
      if (kind === 'order') return ordersSinLoteTable(items);
      if (kind === 'ferm')  return fermentationTable(items);
      if (kind === 'dry')   return dryingTable(items);
    }
    if (kind === 'order') return el('div', { class: 'space-y-2' }, items.map(orderSinLoteRow));
    if (kind === 'ferm')  return el('div', { class: 'space-y-2' }, items.map(fermentationRow));
    if (kind === 'dry')   return el('div', { class: 'space-y-2' }, items.map(dryingRow));
    return null;
  }

  let activeTab = 'alertas';
  const tabbar = createTabBar({
    tabs: [
      { key: 'alertas',    label: 'Alertas' },
      { key: 'operacion',  label: 'Operación en vivo' },
      { key: 'tendencias', label: 'Tendencias' },
    ],
    activeKey: activeTab,
    onChange: (k) => { activeTab = k; tabbar.setContent(renderActiveTab()); },
  });

  function renderActiveTab() {
    if (activeTab === 'operacion')  return renderOperacion();
    if (activeTab === 'tendencias') return renderTendencias();
    return renderAlertas();
  }

  function renderAlertas() {
    const ordersSh    = ordersSinLote.filter(passesOrder);
    const fermSh      = fermentationOverrun.filter(passesLot);
    const dryingSh    = dryingOverrun.filter(passesLot);
    const totalAlerts = ordersSh.length + fermSh.length + dryingSh.length;

    const fb = renderFilterButton({
      filters: sheetFilters,
      values: sheetValues,
      onChange: (v) => { sheetValues = v; tabbar.setContent(renderActiveTab()); },
    });

    return el('div', {}, [
      el('div', { class: 'mb-4 flex items-center justify-between gap-2 flex-wrap' }, [
        fb.el,
        vm.toggleEl,
      ]),

      statRow([
        stat('Alertas totales', totalAlerts, totalAlerts === 0 ? 'Sin pendientes' : 'Necesitan atencion',
          null, { kind: totalAlerts > 0 ? 'warn' : 'ok' }),
        stat('Pedidos sin lote', ordersSh.length, 'kg verde por asignar',
          () => navigate('/finca/lots'),
          { kind: ordersSh.length > 0 ? 'warn' : 'ok' }),
        stat(`Fermentacion >${FERMENTATION_OVERRUN_DAYS}d`, fermSh.length, 'Lotes vencidos',
          null, { kind: fermSh.length > 0 ? 'crit' : 'ok' }),
        stat('Drying vencido', dryingSh.length, 'Excede dias esperados',
          null, { kind: dryingSh.length > 0 ? 'crit' : 'ok' }),
      ]),

      section('Pipeline de produccion', pipelinePanel(pipeline, maxCount, maxKg)),

      section('Pedidos sin lote',
        ordersSh.length === 0
          ? emptyText('Todos los pedidos en curso tienen lote asignado.')
          : listOrTable(ordersSh, 'order'),
      ),

      section('Fermentacion vencida',
        fermSh.length === 0
          ? emptyText('Sin lotes en fermentacion >' + FERMENTATION_OVERRUN_DAYS + 'd.')
          : listOrTable(fermSh, 'ferm'),
      ),

      section('Drying vencido',
        dryingSh.length === 0
          ? emptyText('Sin lotes con drying excedido.')
          : listOrTable(dryingSh, 'dry'),
      ),
    ]);
  }

  function renderOperacion() {
    // Lanes en vivo: fermentación y drying. Cada lote en lane se
    // enriquece con su progreso (% del lead-time) y nivel de alerta.
    const fermLots = lots.filter((l) => l.status === 'InFermentation').map((l) => {
      const target = Number(l.fermentation_hours || DEFAULT_FERMENTATION_HOURS);
      const hoursElapsed = hoursBetween(l.start_date, today);
      const pct = target > 0 ? Math.min(150, (hoursElapsed / target) * 100) : 0;
      const level = pct >= 100 ? 'red' : pct >= ALERT_AMBER_PCT * 100 ? 'amber' : 'green';
      return { ...l, _hoursElapsed: hoursElapsed, _hoursTarget: target, _pct: pct, _level: level };
    }).sort((a, b) => b._pct - a._pct);

    const dryLots = lots.filter((l) => l.status === 'Drying').map((l) => {
      const cfg = leadByProcess.get(l.process_type);
      const target = cfg ? Number(cfg.drying_days) : null;
      const daysElapsed = l.drying_start_date ? daysBetween(l.drying_start_date, today) : 0;
      const pct = target && target > 0 ? Math.min(150, (daysElapsed / target) * 100) : 0;
      const level = !target ? 'green'
        : pct >= 100 ? 'red'
        : pct >= ALERT_AMBER_PCT * 100 ? 'amber' : 'green';
      const partials = (l.partials || []).filter((p) => !p.rejected_at);
      return { ...l, _daysElapsed: daysElapsed, _daysTarget: target, _pct: pct, _level: level, _partialsCount: partials.length };
    }).sort((a, b) => b._pct - a._pct);

    return el('div', { class: 'grid grid-cols-1 lg:grid-cols-2 gap-4' }, [
      laneSection({
        title: 'Fermentación',
        accent: '#7e9ec1',
        lots: fermLots,
        emptyText: 'No hay baches en fermentación.',
        kpis: laneKpis(fermLots, 'ferm'),
        renderCard: (l) => laneCardFerm(l),
      }),
      laneSection({
        title: 'Secado (Drying)',
        accent: '#ddae3e',
        lots: dryLots,
        emptyText: 'No hay baches en secado.',
        kpis: laneKpis(dryLots, 'dry'),
        renderCard: (l) => laneCardDrying(l),
      }),
    ]);
  }

  function renderTendencias() {
    // Productividad de la planta — últimos 12 meses calendario.
    //   Hero KPIs (mes actual vs anterior) +
    //   Chart de flujo: 3 barras por mes (cereza in / seco out / verde out)
    //     con factor de rendimiento promedio como línea encima +
    //   Chart de tiempo de ciclo promedio (cereza → verde, en días).
    const months = lastNMonths(today, 12);
    const stats  = computeMonthlyStats(lots, months);
    const cur    = stats[stats.length - 1] || null;
    const prev   = stats[stats.length - 2] || null;
    const curInProgress = cur && cur.key === today.slice(0, 7);

    return el('div', { class: 'space-y-5' }, [
      el('div', { class: 'flex items-baseline justify-between gap-2 flex-wrap' }, [
        el('p', { class: 'eyebrow', text: cur ? `${monthLabel(cur.key)} vs ${prev ? monthLabel(prev.key) : '—'}` : 'Sin datos' }),
        curInProgress
          ? el('span', { class: 'ctrm-pill', style: 'background:#fbe6c2;color:#8a5100;', text: 'Mes en curso' })
          : null,
      ]),
      heroKpiGrid(cur, prev),

      el('div', { class: 'grid grid-cols-1 lg:grid-cols-2 gap-4' }, [
        el('div', { class: 'ctrm-card overflow-hidden' }, [
          chartHeader('Seco producido por proceso · 12 meses', PROCS.map((p) => legendSwatch(PROC_COLORS[p], p))),
          el('div', { class: 'px-3 pb-3' }, [stackedByProcessChart(stats, 'seco_by_proc')]),
        ]),
        el('div', { class: 'ctrm-card overflow-hidden' }, [
          chartHeader('Verde producido por proceso · 12 meses', PROCS.map((p) => legendSwatch(PROC_COLORS[p], p))),
          el('div', { class: 'px-3 pb-3' }, [stackedByProcessChart(stats, 'verde_by_proc')]),
        ]),
      ]),

      el('div', { class: 'ctrm-card overflow-hidden' }, [
        chartHeader('Tiempo de ciclo por proceso · 12 meses',
          PROCS.map((p) => legendLine(PROC_COLORS[p], p)),
          'Días promedio cereza → verde de los baches cerrados ese mes'),
        el('div', { class: 'px-3 pb-3' }, [cycleByProcessChart(stats)]),
      ]),
    ]);
  }

  function chartHeader(title, legendItems, hint) {
    return el('div', { class: 'px-3 pt-3 pb-2 flex items-center justify-between gap-3 flex-wrap' }, [
      el('div', {}, [
        el('p', { class: 'eyebrow', text: title }),
        hint ? el('p', { class: 'text-[11px] font-mono text-ink-500 mt-0.5', text: hint }) : null,
      ]),
      el('div', { class: 'flex items-center gap-3 text-[11px] font-mono text-ink-700 flex-wrap' }, legendItems),
    ]);
  }

  function redraw() {
    clear(root);
    tabbar.setContent(renderActiveTab());
    root.append(
      pageTitle('Monitoreo', `Hoy: ${today}`),
      tabbar.el,
      tabbar.panel,
    );
  }
  redraw();
  return chrome(root);
}

// ── Pipeline panel ──────────────────────────────────────────────────
function pipelinePanel(pipeline, maxCount, maxKg) {
  return el('div', { class: 'ctrm-card ctrm-card-pad space-y-4' }, [
    el('p', { class: 'eyebrow', text: 'Baches por etapa' }),
    el('div', { class: 'space-y-2' },
      STAGE_ORDER.map((stage) => barRow(stage, pipeline[stage].count, maxCount, 'count'))),
    el('p', { class: 'eyebrow mt-3', text: 'kg verde por etapa' }),
    el('div', { class: 'space-y-2' },
      STAGE_ORDER.map((stage) => barRow(stage, pipeline[stage].kg, maxKg, 'kg'))),
  ]);
}

function barRow(stage, value, max, kind) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const color = stageColor(stage);
  const formatted = kind === 'kg' ? fmtKg(value) : String(value);
  return el('div', { class: 'flex items-center gap-3' }, [
    el('div', { class: 'w-28 shrink-0 text-[12px] text-ink-700', text: statusLabel(stage) }),
    el('div', { class: 'flex-1 h-5 rounded-md bg-cream relative overflow-hidden border border-sand' }, [
      el('div', {
        class: 'h-full',
        style: `width:${pct}%;background:${color};`,
      }),
    ]),
    el('div', { class: 'w-24 shrink-0 text-right font-mono text-[12px] text-ink-700', text: formatted }),
  ]);
}

function stageColor(stage) {
  switch (stage) {
    case 'InFermentation': return '#7e9ec1'; // navy-soft
    case 'Drying':         return '#ddae3e'; // mustard
    case 'Ready':          return '#5d8b66'; // forest
    case 'Delivered':      return '#9aa3ae'; // ink-300
    default:               return '#cbd2db';
  }
}

// ── Row renderers ───────────────────────────────────────────────────
function orderSinLoteRow(o) {
  return el('div', { class: 'ctrm-card ctrm-card-pad' }, [
    el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-1' }, [
      el('div', { class: 'flex items-center gap-2 flex-wrap min-w-0' }, [
        el('span', { class: 'ctrm-code', text: o.order_code }),
        el('span', { class: 'font-display font-semibold text-navy text-[13px] truncate', text: o.reference_name || '—' }),
        el('span', { class: `ctrm-pill ${statusPillKind(o.status)}`, text: statusLabel(o.status) }),
        ...(o.infusion_names || []).map((n) =>
          el('span', { class: 'ctrm-pill', style: 'background:#fbe6c2;color:#8a5100;', text: n })),
      ]),
      el('button', {
        class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
        onClick: () => navigate('/finca/lots'),
      }, ['Asignar lote']),
    ]),
    el('div', { class: 'flex flex-wrap text-[12px] text-ink-500 gap-x-4 gap-y-1 font-mono' }, [
      meta('Pendiente', fmtKg(o.pendiente_kg)),
      meta('Aceptado',  fmtKg(o.kg_green_accepted)),
      meta('Asignado',  fmtKg(o.allocated_kg)),
      meta('Entrega',   fmtDate(o.max_delivery_date)),
      meta('Proceso',   o.process_type),
    ]),
  ]);
}

function fermentationRow(l) {
  return el('div', { class: 'ctrm-card ctrm-card-pad' }, [
    el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-1' }, [
      el('div', { class: 'flex items-center gap-2 flex-wrap min-w-0' }, [
        el('span', { class: 'ctrm-code', text: l.bache_code || l.lot_code }),
        el('span', { class: 'font-display font-semibold text-navy text-[13px] truncate', text: l.reference_name || '—' }),
        el('span', { class: 'ctrm-pill urgency-red', text: `${l.days_in_fermentation}d en fermentacion` }),
        l.infusion_name
          ? el('span', { class: 'ctrm-pill', style: 'background:#fbe6c2;color:#8a5100;', text: `${l.infusion_name} ${l.infusion_pct}%` })
          : null,
      ]),
      el('button', {
        class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
        onClick: () => navigate('/finca/lots'),
      }, ['Ver lote']),
    ]),
    el('div', { class: 'flex flex-wrap text-[12px] text-ink-500 gap-x-4 gap-y-1 font-mono' }, [
      meta('Inicio',   fmtDate(l.start_date)),
      meta('Cereza',   fmtKg(l.kg_cherry_input)),
      meta('Verde esp.', fmtKg(l.kg_green_expected)),
      meta('Proceso',  l.process_type),
    ]),
  ]);
}

function dryingRow(l) {
  return el('div', { class: 'ctrm-card ctrm-card-pad' }, [
    el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-1' }, [
      el('div', { class: 'flex items-center gap-2 flex-wrap min-w-0' }, [
        el('span', { class: 'ctrm-code', text: l.bache_code || l.lot_code }),
        el('span', { class: 'font-display font-semibold text-navy text-[13px] truncate', text: l.reference_name || '—' }),
        el('span', { class: 'ctrm-pill urgency-red', text: `+${l.over_days}d sobre esperado` }),
        l.infusion_name
          ? el('span', { class: 'ctrm-pill', style: 'background:#fbe6c2;color:#8a5100;', text: `${l.infusion_name} ${l.infusion_pct}%` })
          : null,
      ]),
      el('button', {
        class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
        onClick: () => navigate('/finca/lots'),
      }, ['Cerrar bache']),
    ]),
    el('div', { class: 'flex flex-wrap text-[12px] text-ink-500 gap-x-4 gap-y-1 font-mono' }, [
      meta('Drying inicio', fmtDate(l.drying_start_date)),
      meta('Dias en drying', `${l.days_in_drying}`),
      meta('Esperado', `${l.drying_days_expected}d`),
      meta('Parciales', `${(l.partials || []).length}/6`),
      meta('Proceso', l.process_type),
    ]),
  ]);
}

// ── Helpers ─────────────────────────────────────────────────────────
function statRow(items) {
  return el('div', { class: 'grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5' }, items);
}

function stat(label, value, hint, onClick, opts = {}) {
  const valClass = opts.kind ? `stat-val ${opts.kind}` : 'stat-val';
  if (!onClick) {
    return el('div', { class: 'stat-card' }, [
      el('p', { class: 'stat-label', text: label }),
      el('p', { class: valClass, text: String(value) }),
      el('p', { class: 'stat-sub', text: hint }),
    ]);
  }
  return el('button', {
    class: 'stat-card is-clickable text-left',
    type: 'button', onClick,
  }, [
    el('p', { class: 'stat-label', text: label }),
    el('p', { class: valClass, text: String(value) }),
    el('p', { class: 'stat-sub', text: hint }),
  ]);
}

function section(title, children) {
  return el('section', { class: 'mb-6' }, [
    el('h3', { class: 'eyebrow mb-2', text: title }),
    Array.isArray(children)
      ? el('div', { class: 'space-y-2' }, children)
      : children,
  ]);
}

function emptyText(t) {
  return el('p', { class: 'text-[12px] text-ink-300 italic px-1', text: t });
}

function meta(label, value) {
  return el('span', { class: 'inline-flex items-baseline gap-1' }, [
    el('span', { class: 'text-ink-300 uppercase tracking-loose text-[10px] font-sans font-semibold', text: label }),
    el('strong', { class: 'text-ink-700 font-mono', text: String(value) }),
  ]);
}

function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return 0;
  const a = new Date(fromIso + 'T00:00:00Z');
  const b = new Date(toIso   + 'T00:00:00Z');
  return Math.floor((b - a) / 86400000);
}

function hoursBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return 0;
  const a = new Date(fromIso + 'T00:00:00Z');
  const b = new Date(toIso   + 'T00:00:00Z');
  return Math.max(0, Math.floor((b - a) / 3600000));
}

// ── Lane renderers (tab Operación) ──────────────────────────────────
const LEVEL_COLOR = {
  green: '#5d8b66',
  amber: '#ddae3e',
  red:   '#c45a4f',
};

function laneSection({ title, accent, lots, emptyText, kpis, renderCard }) {
  return el('div', { class: 'ctrm-card overflow-hidden' }, [
    el('div', { class: 'px-3 py-2', style: `background:${accent};` }, [
      el('p', { class: 'font-display font-semibold uppercase tracking-eyebrow text-[12px]', style: 'color:#fff;', text: title }),
    ]),
    el('div', { class: 'px-3 py-2 border-b border-sand bg-cream flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-700 font-mono' }, kpis),
    lots.length === 0
      ? el('p', { class: 'p-4 text-[12px] text-ink-300 italic', text: emptyText })
      : el('div', { class: 'p-3 space-y-2 max-h-[60vh] overflow-y-auto' }, lots.map(renderCard)),
  ]);
}

function laneKpis(lots, kind) {
  const total = lots.length;
  const reds  = lots.filter((l) => l._level === 'red').length;
  const ambers = lots.filter((l) => l._level === 'amber').length;
  const kgKey = kind === 'ferm' ? 'kg_cherry_input' : 'kg_dried_output';
  const kgSum = lots.reduce((s, l) => s + Number(l[kgKey] || 0), 0);
  const kgLabel = kind === 'ferm' ? 'Cereza in' : 'Seco proyectado';
  return [
    kpiPill('Baches', String(total)),
    kpiPill(kgLabel, fmtKg(kgSum)),
    kpiPill('Críticos', String(reds), reds > 0 ? 'crit' : null),
    kpiPill('Atención', String(ambers), ambers > 0 ? 'warn' : null),
  ];
}

function kpiPill(label, value, kind) {
  const color = kind === 'crit' ? '#c45a4f' : kind === 'warn' ? '#8a5100' : '#2a2a28';
  return el('span', { class: 'inline-flex items-baseline gap-1' }, [
    el('span', { class: 'text-ink-300 uppercase tracking-loose text-[10px] font-sans font-semibold', text: label }),
    el('strong', { style: `color:${color};`, text: value }),
  ]);
}

function laneCardFerm(l) {
  const target = l._hoursTarget;
  const elapsed = l._hoursElapsed;
  const color = LEVEL_COLOR[l._level];
  return el('button', {
    type: 'button',
    class: 'w-full text-left ctrm-card ctrm-card-pad block hover:border-navy',
    onClick: () => navigate('/finca/lots'),
  }, [
    el('div', { class: 'flex items-center justify-between gap-2 flex-wrap mb-1' }, [
      el('div', { class: 'flex items-center gap-2 flex-wrap min-w-0' }, [
        el('span', { class: 'ctrm-code', text: l.bache_code || l.lot_code }),
        el('span', { class: 'font-display font-semibold text-navy text-[12px] truncate', text: l.reference_name || '—' }),
        el('span', { class: 'ctrm-pill muted', text: l.process_type }),
        l.infusion_name
          ? el('span', { class: 'ctrm-pill', style: 'background:#fbe6c2;color:#8a5100;', text: l.infusion_name })
          : null,
      ]),
      el('span', { class: 'text-[11px] font-mono font-bold', style: `color:${color};`,
        text: `${elapsed}h / ${target}h` }),
    ]),
    progressBar(l._pct, color),
    el('div', { class: 'flex flex-wrap text-[10px] text-ink-500 gap-x-3 gap-y-0.5 font-mono mt-1' }, [
      meta('Inicio', fmtDate(l.start_date)),
      meta('Cereza', fmtKg(l.kg_cherry_input)),
      meta('Verde esp.', fmtKg(l.kg_green_expected)),
    ]),
  ]);
}

function laneCardDrying(l) {
  const target = l._daysTarget;
  const elapsed = l._daysElapsed;
  const remaining = target != null ? target - elapsed : null;
  const color = LEVEL_COLOR[l._level];
  return el('button', {
    type: 'button',
    class: 'w-full text-left ctrm-card ctrm-card-pad block hover:border-navy',
    onClick: () => navigate('/finca/lots'),
  }, [
    el('div', { class: 'flex items-center justify-between gap-2 flex-wrap mb-1' }, [
      el('div', { class: 'flex items-center gap-2 flex-wrap min-w-0' }, [
        el('span', { class: 'ctrm-code', text: l.bache_code || l.lot_code }),
        el('span', { class: 'font-display font-semibold text-navy text-[12px] truncate', text: l.reference_name || '—' }),
        el('span', { class: 'ctrm-pill muted', text: l.process_type }),
        l._partialsCount > 0
          ? el('span', { class: 'ctrm-pill', text: `${l._partialsCount}/6 parciales` })
          : null,
      ]),
      el('span', { class: 'text-[11px] font-mono font-bold', style: `color:${color};`,
        text: target ? `${elapsed}d / ${target}d` : `${elapsed}d` }),
    ]),
    progressBar(l._pct, color),
    el('div', { class: 'flex flex-wrap text-[10px] text-ink-500 gap-x-3 gap-y-0.5 font-mono mt-1' }, [
      meta('Inicio drying', fmtDate(l.drying_start_date)),
      remaining != null ? meta('Restan', `${Math.max(0, remaining)}d`) : null,
      meta('Verde esp.', fmtKg(l.kg_green_expected)),
    ]),
  ]);
}

function progressBar(pct, color) {
  const w = Math.min(100, Math.max(0, pct));
  return el('div', { class: 'h-2 rounded-md bg-cream relative overflow-hidden border border-sand' }, [
    el('div', { class: 'h-full', style: `width:${w}%;background:${color};` }),
  ]);
}

// ── Productividad: stats + charts ───────────────────────────────────
const PROCS = ['Natural', 'Honey', 'Lavado'];
const PROC_COLORS = {
  Natural: '#3a6f4a',  // verde oscuro
  Honey:   '#ddae3e',  // mostaza
  Lavado:  '#7e9ec1',  // navy-soft
};

function blankByProc() { return { Natural: 0, Honey: 0, Lavado: 0 }; }
function blankCycleByProc() {
  return {
    Natural: { num: 0, den: 0 },
    Honey:   { num: 0, den: 0 },
    Lavado:  { num: 0, den: 0 },
  };
}

function computeMonthlyStats(lots, months) {
  const map = new Map(months.map((m) => [m.key, {
    key: m.key,
    cereza_in: 0, seco_out: 0, verde_out: 0,
    closed: 0,
    factor_num: 0, factor_den: 0,
    cycle_num: 0, cycle_den: 0,
    seco_by_proc:  blankByProc(),
    verde_by_proc: blankByProc(),
    cycle_by_proc: blankCycleByProc(),
  }]));
  for (const l of lots) {
    const proc = PROCS.includes(l.process_type) ? l.process_type : null;
    const fermKey = monthKeyOf(l.start_date);
    if (fermKey && map.has(fermKey)) {
      map.get(fermKey).cereza_in += Number(l.kg_cherry_input || 0);
    }
    const readyKey = monthKeyOf(l.ready_date);
    if (readyKey && map.has(readyKey)) {
      const s = map.get(readyKey);
      const dried = Number(l.kg_dried_output || 0);
      const green = Number(l.kg_green_actual || 0);
      s.closed += 1;
      s.seco_out  += dried;
      s.verde_out += green;
      if (proc) {
        s.seco_by_proc[proc]  += dried;
        s.verde_by_proc[proc] += green;
      }
      const factor = Number(l.factor_rendimiento || 0);
      if (factor > 0 && green > 0) {
        s.factor_num += factor * green;
        s.factor_den += green;
      }
      if (l.start_date && l.ready_date) {
        const dCycle = daysBetween(l.start_date, l.ready_date);
        if (dCycle > 0) {
          s.cycle_num += dCycle;
          s.cycle_den += 1;
          if (proc) {
            s.cycle_by_proc[proc].num += dCycle;
            s.cycle_by_proc[proc].den += 1;
          }
        }
      }
    }
  }
  return months.map((m) => {
    const s = map.get(m.key);
    const cycleProc = {};
    for (const p of PROCS) {
      cycleProc[p] = s.cycle_by_proc[p].den > 0
        ? s.cycle_by_proc[p].num / s.cycle_by_proc[p].den
        : null;
    }
    return {
      ...s,
      factor:     s.factor_den > 0 ? s.factor_num / s.factor_den : null,
      cycle_days: s.cycle_den > 0 ? s.cycle_num / s.cycle_den   : null,
      cycle_days_by_proc: cycleProc,
    };
  });
}

// Hero KPIs ─────────────────────────────────────────────────────────
function heroKpiGrid(cur, prev) {
  if (!cur) return el('p', { class: 'text-[12px] text-ink-300 italic', text: 'Sin datos.' });
  return el('div', { class: 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2' }, [
    kpiCard('Cereza in',     fmtKg(cur.cereza_in),                            pctDelta(cur.cereza_in, prev?.cereza_in)),
    kpiCard('Seco producido',fmtKg(cur.seco_out),                             pctDelta(cur.seco_out,  prev?.seco_out)),
    kpiCard('Verde out',     fmtKg(cur.verde_out),                            pctDelta(cur.verde_out, prev?.verde_out)),
    kpiCard('Baches',        String(cur.closed),                              absDelta(cur.closed,    prev?.closed)),
    kpiCard('Factor prom.',  cur.factor != null ? cur.factor.toFixed(2) + '×' : '—',
                              absDelta(cur.factor, prev?.factor, 2), { inverted: true }),
    kpiCard('Ciclo prom.',   cur.cycle_days != null ? Math.round(cur.cycle_days) + 'd' : '—',
                              absDelta(cur.cycle_days, prev?.cycle_days, 0),  { inverted: true }),
  ]);
}

function kpiCard(label, value, delta, opts = {}) {
  let deltaEl = null;
  if (delta) {
    const inverted = !!opts.inverted;
    const good = delta.isUp == null ? null : inverted ? !delta.isUp : delta.isUp;
    const color = good == null ? '#9aa3ae' : good ? '#5d8b66' : '#c45a4f';
    deltaEl = el('p', { class: 'stat-sub', style: `color:${color};`, text: `${delta.sign} ${delta.text}` });
  }
  return el('div', { class: 'stat-card' }, [
    el('p', { class: 'stat-label', text: label }),
    el('p', { class: 'stat-val',   text: value }),
    deltaEl || el('p', { class: 'stat-sub', text: '—' }),
  ]);
}

function pctDelta(cur, prev) {
  if (prev == null || prev === 0) return null;
  const d = ((cur - prev) / prev) * 100;
  if (!Number.isFinite(d)) return null;
  return {
    sign: d > 0 ? '↑' : d < 0 ? '↓' : '·',
    text: `${d > 0 ? '+' : ''}${d.toFixed(0)}% vs mes ant.`,
    isUp: d === 0 ? null : d > 0,
  };
}

function absDelta(cur, prev, decimals = 0) {
  if (cur == null || prev == null) return null;
  const d = cur - prev;
  const fmt = (v) => (decimals > 0 ? v.toFixed(decimals) : String(Math.round(v)));
  return {
    sign: d > 0 ? '↑' : d < 0 ? '↓' : '·',
    text: `${d > 0 ? '+' : ''}${fmt(d)} vs mes ant.`,
    isUp: d === 0 ? null : d > 0,
  };
}

// Legend swatches ───────────────────────────────────────────────────
function legendSwatch(color, label) {
  return el('span', { class: 'inline-flex items-center gap-1' }, [
    el('span', { style: `display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};` }),
    el('span', { text: label }),
  ]);
}
function legendLine(color, label) {
  return el('span', { class: 'inline-flex items-center gap-1' }, [
    el('span', { style: `display:inline-block;width:14px;height:2px;background:${color};` }),
    el('span', { text: label }),
  ]);
}

// Stacked bars por proceso (Natural / Honey / Lavado) ───────────────
function stackedByProcessChart(stats, key) {
  const W = 800, H = 220, padL = 48, padR = 16, padT = 14, padB = 32;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = stats.length;
  const groupW = innerW / n;
  const barW = Math.max(8, groupW * 0.6);
  const totals = stats.map((s) => PROCS.reduce((acc, p) => acc + (s[key][p] || 0), 0));
  const maxV = Math.max(1, ...totals);
  const yV = (v) => padT + innerH - (v / maxV) * innerH;

  if (totals.every((v) => v <= 0)) {
    return el('p', { class: 'text-[12px] text-ink-300 italic', text: 'Sin producción registrada en el periodo.' });
  }

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: '100%',
    style: 'height:auto;display:block;',
    'aria-label': 'Producción por proceso',
  });

  // Gridlines + Y labels (kg)
  for (let i = 0; i <= 4; i++) {
    const y = padT + (innerH * i) / 4;
    const v = maxV * (1 - i / 4);
    svg.append(svgEl('line', {
      x1: padL, x2: W - padR, y1: y, y2: y,
      stroke: '#ecebe6', 'stroke-width': '1',
    }));
    svg.append(svgEl('text', {
      x: padL - 6, y: y + 3, 'text-anchor': 'end',
      'font-size': '10', fill: '#9aa3ae', 'font-family': 'monospace',
    }, fmtKg(v)));
  }

  // Stacked bars
  stats.forEach((s, i) => {
    const cx = padL + i * groupW + groupW / 2;
    let yCursor = padT + innerH; // arranca desde abajo y sube
    for (const p of PROCS) {
      const v = s[key][p] || 0;
      if (v <= 0) continue;
      const h = (v / maxV) * innerH;
      const y = yCursor - h;
      svg.append(svgEl('rect', {
        x: cx - barW / 2, y, width: barW, height: Math.max(1, h),
        fill: PROC_COLORS[p],
      }));
      yCursor = y;
    }
    // total arriba de la barra
    const total = totals[i];
    if (total > 0) {
      svg.append(svgEl('text', {
        x: cx, y: yV(total) - 4, 'text-anchor': 'middle',
        'font-size': '10', fill: '#1a3a5c', 'font-family': 'monospace',
      }, fmtKg(total)));
    }
    // mes label
    svg.append(svgEl('text', {
      x: cx, y: H - padB + 14, 'text-anchor': 'middle',
      'font-size': '10', fill: '#5b5b58', 'font-family': 'monospace',
    }, monthShort(s.key)));
  });

  return svg;
}

// Multi-line: tiempo de ciclo por proceso ───────────────────────────
function cycleByProcessChart(stats) {
  const W = 800, H = 200, padL = 48, padR = 16, padT = 14, padB = 32;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = stats.length;
  const xStep = innerW / Math.max(1, n - 1);

  const allVals = stats.flatMap((s) => PROCS.map((p) => s.cycle_days_by_proc[p]).filter((v) => v != null && v > 0));
  if (allVals.length === 0) {
    return el('p', { class: 'text-[12px] text-ink-300 italic', text: 'Sin baches cerrados con proceso válido en el periodo.' });
  }
  const maxV = Math.max(...allVals) * 1.15;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: '100%',
    style: 'height:auto;display:block;',
    'aria-label': 'Tiempo de ciclo por proceso',
  });

  // Gridlines + Y labels (days)
  for (let i = 0; i <= 3; i++) {
    const y = padT + (innerH * i) / 3;
    const v = maxV * (1 - i / 3);
    svg.append(svgEl('line', {
      x1: padL, x2: W - padR, y1: y, y2: y,
      stroke: '#ecebe6', 'stroke-width': '1',
    }));
    svg.append(svgEl('text', {
      x: padL - 6, y: y + 3, 'text-anchor': 'end',
      'font-size': '10', fill: '#9aa3ae', 'font-family': 'monospace',
    }, `${Math.round(v)}d`));
  }

  // X labels
  stats.forEach((s, i) => {
    const cx = padL + i * xStep;
    svg.append(svgEl('text', {
      x: cx, y: H - padB + 14, 'text-anchor': 'middle',
      'font-size': '10', fill: '#5b5b58', 'font-family': 'monospace',
    }, monthShort(s.key)));
  });

  // Una línea por proceso
  for (const p of PROCS) {
    const color = PROC_COLORS[p];
    const pts = stats.map((s, i) => {
      const v = s.cycle_days_by_proc[p];
      if (v == null || v <= 0) return null;
      const x = padL + i * xStep;
      const y = padT + innerH - (v / maxV) * innerH;
      return [x, y, v];
    }).filter(Boolean);

    if (pts.length >= 2) {
      const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
      svg.append(svgEl('path', {
        d, fill: 'none', stroke: color, 'stroke-width': '2',
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      }));
    }
    pts.forEach(([x, y]) => {
      svg.append(svgEl('circle', { cx: x, cy: y, r: '3', fill: color }));
    });
  }

  return svg;
}

function monthShort(key) {
  const [, m] = key.split('-');
  return MONTH_ES[Number(m) - 1] || key;
}

function svgEl(tag, attrs = {}, text = null) {
  const ns = 'http://www.w3.org/2000/svg';
  const node = document.createElementNS(ns, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text != null) node.textContent = String(text);
  return node;
}

// ── Month helpers ──────────────────────────────────────────────────
const MONTH_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function monthKeyOf(ymd) {
  if (!ymd) return null;
  const s = String(ymd).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s.slice(0, 7); // YYYY-MM
}

function monthLabel(key) {
  const [y, m] = key.split('-');
  return `${MONTH_ES[Number(m) - 1]} ${y}`;
}

function lastNMonths(todayYmd, n) {
  // Devuelve [oldest..newest] meses calendario. Cada item: { key: 'YYYY-MM' }.
  let [y, m] = todayYmd.split('-').map(Number); // m = 1..12
  const out = [];
  for (let i = 0; i < n; i++) {
    out.unshift({ key: `${y}-${String(m).padStart(2, '0')}` });
    m -= 1;
    if (m < 1) { m = 12; y -= 1; }
  }
  return out;
}

// ─── Table renderers ──────────────────────────────────────────────
function tableShell(headers, rows) {
  const wrap = el('div', { class: 'overflow-x-auto ctrm-card' });
  const t = el('table', { class: 'w-full text-[12px] responsive-stack' }, [
    el('thead', {}, [el('tr', {}, headers.map((h) =>
      el('th', { class: h.cls || '' }, [h.label])))]),
    el('tbody', {}, rows),
  ]);
  wrap.append(t);
  return wrap;
}
function tcell(label, classes, content) {
  const td = el('td', { class: classes });
  td.setAttribute('data-label', label);
  if (content instanceof Node) td.append(content);
  else td.append(document.createTextNode(String(content == null ? '—' : content)));
  return td;
}

function ordersSinLoteTable(orders) {
  return tableShell(
    [
      { label: 'Pedido' }, { label: 'Referencia' }, { label: 'Cliente' },
      { label: 'Pendiente', cls: 'text-right' }, { label: 'Aceptado', cls: 'text-right' },
      { label: 'Entrega' }, { label: 'Proceso' }, { label: 'Infusión' },
    ],
    orders.map((o) => el('tr', {
      class: 'cursor-pointer hover:bg-cream',
      onClick: () => navigate('/finca/lots'),
    }, [
      tcell('Pedido', 'font-mono text-navy font-semibold', o.order_code),
      tcell('Referencia', '', o.reference_name || '—'),
      tcell('Cliente', '', o.client_name || '—'),
      tcell('Pendiente', 'text-right font-mono text-warn font-bold', fmtKg(o.pendiente_kg)),
      tcell('Aceptado',  'text-right font-mono', fmtKg(o.kg_green_accepted)),
      tcell('Entrega', 'font-mono text-[11px]', fmtDate(o.max_delivery_date)),
      tcell('Proceso', 'text-[11px]', o.process_type),
      tcell('Infusión', 'text-[11px]', (o.infusion_names || []).join(', ') || '—'),
    ])),
  );
}

function fermentationTable(lots) {
  return tableShell(
    [
      { label: 'Bache' }, { label: 'Referencia' },
      { label: 'Días', cls: 'text-right' }, { label: 'Inicio' },
      { label: 'Cereza', cls: 'text-right' }, { label: 'Verde esp.', cls: 'text-right' },
      { label: 'Proceso' }, { label: 'Infusión' },
    ],
    lots.map((l) => el('tr', {
      class: 'cursor-pointer hover:bg-cream',
      onClick: () => navigate('/finca/lots'),
    }, [
      tcell('Bache', 'font-mono text-navy font-semibold', l.bache_code || l.lot_code),
      tcell('Referencia', '', l.reference_name || '—'),
      tcell('Días', 'text-right font-mono text-crit font-bold', `${l.days_in_fermentation}d`),
      tcell('Inicio', 'font-mono text-[11px]', fmtDate(l.start_date)),
      tcell('Cereza', 'text-right font-mono', fmtKg(l.kg_cherry_input)),
      tcell('Verde esp.', 'text-right font-mono', fmtKg(l.kg_green_expected)),
      tcell('Proceso', 'text-[11px]', l.process_type),
      tcell('Infusión', 'text-[11px]', l.infusion_name ? `${l.infusion_name} ${l.infusion_pct}%` : '—'),
    ])),
  );
}

function dryingTable(lots) {
  return tableShell(
    [
      { label: 'Bache' }, { label: 'Referencia' },
      { label: 'Días drying', cls: 'text-right' }, { label: 'Esperado', cls: 'text-right' },
      { label: 'Inicio' }, { label: 'Parciales', cls: 'text-right' },
      { label: 'Proceso' }, { label: 'Infusión' },
    ],
    lots.map((l) => el('tr', {
      class: 'cursor-pointer hover:bg-cream',
      onClick: () => navigate('/finca/lots'),
    }, [
      tcell('Bache', 'font-mono text-navy font-semibold', l.bache_code || l.lot_code),
      tcell('Referencia', '', l.reference_name || '—'),
      tcell('Días drying', 'text-right font-mono text-crit font-bold',
        `${l.days_in_drying}d (+${l.over_days})`),
      tcell('Esperado', 'text-right font-mono', `${l.drying_days_expected}d`),
      tcell('Inicio', 'font-mono text-[11px]', fmtDate(l.drying_start_date)),
      tcell('Parciales', 'text-right font-mono', `${(l.partials || []).length}/6`),
      tcell('Proceso', 'text-[11px]', l.process_type),
      tcell('Infusión', 'text-[11px]', l.infusion_name ? `${l.infusion_name} ${l.infusion_pct}%` : '—'),
    ])),
  );
}
