// Finca monitoring — alertas operativas + pipeline visual.
// Pedidos sin lote, lotes con fermentation/drying excedidos, distribucion
// por etapa.
import { el, clear } from '../ui/el.js';
import { fmtKg, fmtDate, statusLabel, statusPillKind } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { navigate } from '../router.js';
import { renderFilterButton } from '../ui/filters-sheet.js';
import { createViewMode } from '../ui/view-mode.js';

const STAGE_ORDER = ['InFermentation', 'Drying', 'Ready', 'Delivered'];

// Tolerancia (en dias) sobre los lead-times antes de marcar como vencido.
const FERMENTATION_OVERRUN_DAYS = 5;   // si el lote sigue InFermentation > 5d
const DRYING_GRACE_DAYS = 0;           // any day past drying_days is overrun

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
    if (lot.status === 'Delivered') continue;
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
  function redraw() {
    const ordersSh    = ordersSinLote.filter(passesOrder);
    const fermSh      = fermentationOverrun.filter(passesLot);
    const dryingSh    = dryingOverrun.filter(passesLot);
    const totalAlerts = ordersSh.length + fermSh.length + dryingSh.length;

    const fb = renderFilterButton({
      filters: sheetFilters,
      values: sheetValues,
      onChange: (v) => { sheetValues = v; redraw(); },
    });

    clear(root);
    root.append(
      pageTitle('Monitoreo', `Hoy: ${today}`),

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
