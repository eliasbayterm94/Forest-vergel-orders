// Shared rendering of /api/capacity-calculate payload — reused by the
// finca inbox preview panel and the finca dashboard weekly load.
import { el } from '../ui/el.js';
import { fmtKg, fmtDate, URGENCY_LABEL } from '../ui/format.js';

/**
 * @param {object} payload  { orders, aggregate, weekly_load }
 * @param {object} opts     { showOrders?: boolean, emptyText?: string }
 */
export function renderCapacityPayload(payload, opts = {}) {
  const { orders = [], aggregate = {}, weekly_load = [] } = payload || {};
  const showOrders = opts.showOrders !== false;

  if (!orders.length && weekly_load.length === 0) {
    return el('p', { class: 'text-sm text-slate-400 italic px-1', text: opts.emptyText || 'Sin datos.' });
  }

  const hasUrgent = orders.some((o) => o.urgency === 'past' || o.urgency === 'red');

  return el('div', { class: 'space-y-4' }, [
    hasUrgent ? warningBanner('Hay pedidos con fecha de inicio crítica o vencida.') : null,
    aggregateBlock(aggregate),
    showOrders ? ordersBlock(orders) : null,
    weeklyChart(weekly_load),
  ]);
}

function aggregateBlock(a) {
  const items = [
    stat('Pedidos',          String(a.order_count ?? 0)),
    stat('Total verde',      fmtKg(a.total_kg_green)),
    stat('Total cereza',     fmtKg(a.total_kg_cherry)),
    stat('Inicio más cercano', fmtDate(a.earliest_drying_start_date)),
    stat('Días hasta inicio', a.days_until_earliest_start == null ? '—' : String(a.days_until_earliest_start)),
    stat('Prom. kg verde/sem', a.avg_kg_green_per_week == null ? '—' : fmtKg(a.avg_kg_green_per_week)),
    stat('Prom. kg cereza/sem', a.avg_kg_cherry_per_week == null ? '—' : fmtKg(a.avg_kg_cherry_per_week)),
  ];
  return el('div', { class: 'grid grid-cols-2 sm:grid-cols-3 gap-2' }, items);
}

function stat(label, value) {
  return el('div', { class: 'rounded-lg bg-slate-50 border border-slate-200 px-3 py-2' }, [
    el('p', { class: 'text-[11px] text-slate-500 uppercase tracking-wide', text: label }),
    el('p', { class: 'text-sm font-semibold text-slate-900', text: value }),
  ]);
}

function ordersBlock(orders) {
  return el('div', {}, [
    el('h4', { class: 'text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1', text: 'Pedidos seleccionados' }),
    el('div', { class: 'space-y-1' }, orders.map((o) =>
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2 text-xs px-2 py-1.5 rounded border border-slate-200 bg-white' }, [
        el('div', { class: 'flex items-center gap-2 min-w-0' }, [
          el('span', { class: 'font-mono text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700', text: o.order_code }),
          el('span', { class: 'truncate', text: o.reference_name || '—' }),
        ]),
        el('div', { class: 'flex items-center gap-2 text-slate-600' }, [
          el('span', {}, [`Inicio: `, el('strong', { text: fmtDate(o.latest_drying_start_date) })]),
          el('span', { class: `px-1.5 py-0.5 rounded urgency-${o.urgency || 'normal'}`, text: URGENCY_LABEL[o.urgency] || o.urgency || '' }),
          el('span', {}, [fmtKg(o.kg_green_for_planning), ' v / ', fmtKg(o.kg_cherry_for_planning), ' c']),
        ]),
      ]),
    )),
  ]);
}

function weeklyChart(weekly_load) {
  const items = weekly_load.slice().sort((a, b) => a.week_start_date.localeCompare(b.week_start_date));
  if (items.length === 0) return null;

  const maxVal = Math.max(
    1,
    ...items.map((w) => Number(w.selected_orders_kg_cherry || 0) + Number(w.active_queue_kg_cherry || 0)),
  );

  return el('div', {}, [
    el('h4', { class: 'text-xs font-semibold text-slate-600 uppercase tracking-wide mb-1', text: 'Carga semanal (kg cereza)' }),
    el('div', { class: 'space-y-1.5' }, items.map((w) => weekRow(w, maxVal))),
    legend(),
  ]);
}

function weekRow(w, maxVal) {
  const sel = Number(w.selected_orders_kg_cherry || 0);
  const act = Number(w.active_queue_kg_cherry || 0);
  const selPct = (sel / maxVal) * 100;
  const actPct = (act / maxVal) * 100;
  const total  = sel + act;

  return el('div', { class: 'flex items-center gap-2 text-xs' }, [
    el('div', { class: 'w-20 shrink-0 text-slate-600 font-mono' }, [w.iso_week_key]),
    el('div', { class: 'flex-1 h-5 bg-slate-100 rounded relative overflow-hidden' }, [
      el('div', {
        class: 'absolute inset-y-0 left-0 bg-forest-light',
        style: { width: `${selPct}%` },
        title: `Seleccionados: ${fmtKg(sel)}`,
      }),
      el('div', {
        class: 'absolute inset-y-0 bg-amber-400',
        style: { left: `${selPct}%`, width: `${actPct}%` },
        title: `En cola activa: ${fmtKg(act)}`,
      }),
    ]),
    el('div', { class: 'w-24 shrink-0 text-right text-slate-700 font-medium' }, [fmtKg(total)]),
  ]);
}

function legend() {
  return el('div', { class: 'flex items-center gap-3 mt-1 text-[11px] text-slate-500' }, [
    el('span', { class: 'flex items-center gap-1' }, [
      el('span', { class: 'inline-block w-3 h-3 rounded bg-forest-light' }), 'Seleccionados',
    ]),
    el('span', { class: 'flex items-center gap-1' }, [
      el('span', { class: 'inline-block w-3 h-3 rounded bg-amber-400' }), 'Cola activa',
    ]),
  ]);
}

function warningBanner(text) {
  return el('div', { class: 'rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs px-3 py-2 flex items-center gap-2' }, [
    el('span', { text: '⚠️' }),
    el('span', { text }),
  ]);
}
