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
    // Últimas 12 semanas ISO. Para cada semana:
    //   ferm_started   — baches con start_date en esa semana
    //   drying_started — baches con drying_start_date en esa semana
    //   closed         — baches con ready_date en esa semana
    //   cereza_in      — sum kg_cherry_input de los que arrancaron en ferm esa semana
    //   verde_out      — sum kg_green_actual de los cerrados esa semana
    //   factor_avg     — promedio ponderado del factor de los cerrados
    const weeks = lastNIsoWeeks(today, 12);
    const byWeek = new Map(weeks.map((w) => [w.key, {
      ...w, ferm: 0, drying: 0, closed: 0, cereza_in: 0, verde_out: 0,
      factor_num: 0, factor_den: 0,
    }]));
    for (const l of lots) {
      const fermKey = isoWeekKeyOf(l.start_date);
      const dryKey  = isoWeekKeyOf(l.drying_start_date);
      const readyKey = isoWeekKeyOf(l.ready_date);
      if (fermKey && byWeek.has(fermKey)) {
        const b = byWeek.get(fermKey);
        b.ferm += 1;
        b.cereza_in += Number(l.kg_cherry_input || 0);
      }
      if (dryKey && byWeek.has(dryKey)) byWeek.get(dryKey).drying += 1;
      if (readyKey && byWeek.has(readyKey)) {
        const b = byWeek.get(readyKey);
        b.closed += 1;
        b.verde_out += Number(l.kg_green_actual || 0);
        const factor = Number(l.factor_rendimiento || 0);
        const dried  = Number(l.kg_dried_output || 0);
        if (factor > 0 && dried > 0) {
          b.factor_num += factor * dried;
          b.factor_den += dried;
        }
      }
    }
    const rows = weeks.map((w) => {
      const b = byWeek.get(w.key);
      const factor = b.factor_den > 0 ? Math.round((b.factor_num / b.factor_den) * 100) / 100 : null;
      return {
        key: w.key, start: w.start,
        ferm: b.ferm, drying: b.drying, closed: b.closed,
        cereza_in: b.cereza_in, verde_out: b.verde_out, factor,
      };
    });

    const series = {
      ferm:      rows.map((r) => r.ferm),
      drying:    rows.map((r) => r.drying),
      closed:    rows.map((r) => r.closed),
      cereza_in: rows.map((r) => r.cereza_in),
      verde_out: rows.map((r) => r.verde_out),
      factor:    rows.map((r) => r.factor || 0),
    };

    return el('div', {}, [
      el('p', { class: 'eyebrow mb-2', text: 'Últimas 12 semanas ISO' }),
      el('div', { class: 'overflow-x-auto ctrm-card' }, [
        el('table', { class: 'w-full text-[12px]' }, [
          el('thead', {}, [
            // Fila 1: sparklines
            el('tr', {}, [
              el('th', { class: 'px-2 py-2 text-left text-[10px] text-ink-300 uppercase tracking-loose' }, ['Sparkline']),
              el('th', { class: 'px-2 py-2' }, [sparkline(series.ferm,      '#7e9ec1')]),
              el('th', { class: 'px-2 py-2' }, [sparkline(series.drying,    '#ddae3e')]),
              el('th', { class: 'px-2 py-2' }, [sparkline(series.closed,    '#5d8b66')]),
              el('th', { class: 'px-2 py-2' }, [sparkline(series.cereza_in, '#c45a4f')]),
              el('th', { class: 'px-2 py-2' }, [sparkline(series.verde_out, '#3a6f4a')]),
              el('th', { class: 'px-2 py-2' }, [sparkline(series.factor,    '#1a3a5c')]),
            ]),
            // Fila 2: labels
            el('tr', { class: 'border-t border-sand' }, [
              el('th', { class: 'px-2 py-2 text-left font-display text-[11px] uppercase tracking-eyebrow text-ink-500' }, ['Semana']),
              el('th', { class: 'px-2 py-2 text-right font-display text-[11px] uppercase tracking-eyebrow text-ink-500' }, ['Ferm. arrancó']),
              el('th', { class: 'px-2 py-2 text-right font-display text-[11px] uppercase tracking-eyebrow text-ink-500' }, ['Drying arrancó']),
              el('th', { class: 'px-2 py-2 text-right font-display text-[11px] uppercase tracking-eyebrow text-ink-500' }, ['Cerrados']),
              el('th', { class: 'px-2 py-2 text-right font-display text-[11px] uppercase tracking-eyebrow text-ink-500' }, ['Cereza in']),
              el('th', { class: 'px-2 py-2 text-right font-display text-[11px] uppercase tracking-eyebrow text-ink-500' }, ['Verde out']),
              el('th', { class: 'px-2 py-2 text-right font-display text-[11px] uppercase tracking-eyebrow text-ink-500' }, ['Factor prom.']),
            ]),
          ]),
          el('tbody', {}, rows.map((r) => el('tr', { class: 'border-t border-sand' }, [
            el('td', { class: 'px-2 py-1.5 font-mono text-ink-700' }, [r.key]),
            el('td', { class: 'px-2 py-1.5 text-right font-mono', text: String(r.ferm)   }),
            el('td', { class: 'px-2 py-1.5 text-right font-mono', text: String(r.drying) }),
            el('td', { class: 'px-2 py-1.5 text-right font-mono', text: String(r.closed) }),
            el('td', { class: 'px-2 py-1.5 text-right font-mono', text: r.cereza_in > 0 ? fmtKg(r.cereza_in) : '—' }),
            el('td', { class: 'px-2 py-1.5 text-right font-mono', text: r.verde_out > 0 ? fmtKg(r.verde_out) : '—' }),
            el('td', { class: 'px-2 py-1.5 text-right font-mono', text: r.factor != null ? String(r.factor) : '—' }),
          ]))),
        ]),
      ]),
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

// ── Sparkline helper (mini SVG line) ────────────────────────────────
function sparkline(values, stroke) {
  const w = 80, h = 22, pad = 2;
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const range = max - min || 1;
  const n = values.length || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i * (w - pad * 2)) / Math.max(1, n - 1);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  const poly = document.createElementNS(ns, 'polyline');
  poly.setAttribute('points', pts);
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', stroke);
  poly.setAttribute('stroke-width', '1.5');
  poly.setAttribute('stroke-linejoin', 'round');
  poly.setAttribute('stroke-linecap', 'round');
  svg.appendChild(poly);
  return svg;
}

// ── ISO week helpers ────────────────────────────────────────────────
function isoWeekKeyOf(ymd) {
  if (!ymd) return null;
  const s = String(ymd).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const isoWeek = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${isoYear}-W${String(isoWeek).padStart(2, '0')}`;
}

function isoWeekStartOf(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (dayNum - 1));
  return d.toISOString().slice(0, 10);
}

function lastNIsoWeeks(todayYmd, n) {
  // Devuelve [oldest..newest] semanas. Cada item: { key, start }.
  const cur = isoWeekStartOf(todayYmd);
  const out = [];
  let cursor = cur;
  for (let i = 0; i < n; i++) {
    out.unshift({ key: isoWeekKeyOf(cursor), start: cursor });
    const dt = new Date(cursor + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() - 7);
    cursor = dt.toISOString().slice(0, 10);
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
