// Shared rendering of /api/capacity-calculate payload — reused by the
// finca inbox preview panel and the finca dashboard weekly load.
// CTRM-styled: yellow + sky bars, eyebrow labels, mono numbers.
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
    return el('p', { class: 'text-[12px] text-ink-300 italic px-1', text: opts.emptyText || 'Sin datos.' });
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
    miniStat('Pedidos',          String(a.order_count ?? 0)),
    miniStat('Total verde',      fmtKg(a.total_kg_green)),
    miniStat('Total cereza',     fmtKg(a.total_kg_cherry)),
    miniStat('Inicio + cercano', fmtDate(a.earliest_drying_start_date)),
    miniStat('Días al inicio',   a.days_until_earliest_start == null ? '—' : String(a.days_until_earliest_start)),
    miniStat('Prom. verde / sem',  a.avg_kg_green_per_week == null ? '—' : fmtKg(a.avg_kg_green_per_week)),
    miniStat('Prom. cereza / sem', a.avg_kg_cherry_per_week == null ? '—' : fmtKg(a.avg_kg_cherry_per_week)),
  ];
  return el('div', { class: 'grid grid-cols-2 sm:grid-cols-3 gap-2' }, items);
}

function miniStat(label, value) {
  return el('div', { class: 'rounded-lg bg-cream border border-sand px-3 py-2' }, [
    el('p', { class: 'eyebrow text-[9.5px] mb-1', text: label }),
    el('p', { class: 'text-[13px] font-display font-bold text-navy leading-tight', text: value }),
  ]);
}

function ordersBlock(orders) {
  return el('div', {}, [
    el('h4', { class: 'eyebrow mb-2', text: 'Pedidos seleccionados' }),
    el('div', { class: 'space-y-1' }, orders.map((o) =>
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2 text-[12px] px-2 py-1.5 rounded-lg border border-sand bg-white' }, [
        el('div', { class: 'flex items-center gap-2 min-w-0' }, [
          el('span', { class: 'ctrm-code', text: o.order_code }),
          el('span', { class: 'truncate text-ink-700', text: o.reference_name || '—' }),
        ]),
        el('div', { class: 'flex items-center gap-2 text-ink-500' }, [
          el('span', {}, [`Inicio: `, el('strong', { class: 'text-navy', text: fmtDate(o.latest_drying_start_date) })]),
          el('span', { class: `ctrm-pill urgency-${o.urgency || 'normal'}`, text: URGENCY_LABEL[o.urgency] || o.urgency || '' }),
          el('span', { class: 'font-mono text-[11px]' }, [fmtKg(o.kg_green_for_planning), ' v / ', fmtKg(o.kg_cherry_for_planning), ' c']),
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
    el('h4', { class: 'eyebrow mb-2', text: 'Carga semanal (kg cereza)' }),
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
  const lostKgGreen   = Number(w.active_queue_kg_green_lost_to_rejection || 0);
  const rejectedCount = Number(w.active_queue_rejected_partial_count || 0);

  return el('div', { class: 'flex items-center gap-2 text-[12px]' }, [
    el('div', { class: 'w-20 shrink-0 font-mono text-[11px] text-ink-500' }, [w.iso_week_key]),
    el('div', { class: 'flex-1 h-5 bg-cream rounded-md relative overflow-hidden border border-sand' }, [
      el('div', {
        class: 'absolute inset-y-0 left-0 bg-yellow',
        style: { width: `${selPct}%` },
        title: `Seleccionados: ${fmtKg(sel)}`,
      }),
      el('div', {
        class: 'absolute inset-y-0 bg-sky',
        style: { left: `${selPct}%`, width: `${actPct}%` },
        title: `En cola activa: ${fmtKg(act)}`,
      }),
    ]),
    el('div', { class: 'w-24 shrink-0 text-right font-mono font-medium text-navy text-[11px]' }, [fmtKg(total)]),
    rejectedCount > 0
      ? el('span', {
          class: 'shrink-0 ctrm-pill urgency-red text-[10px]',
          title: `${rejectedCount} parcial(es) rechazado(s) en esta semana — ${fmtKg(lostKgGreen)} verde no se va a producir`,
          text: `−${fmtKg(lostKgGreen)} v`,
        })
      : null,
  ]);
}

function legend() {
  return el('div', { class: 'flex items-center gap-3 mt-2 text-[10px] text-ink-500 font-mono uppercase tracking-loose' }, [
    el('span', { class: 'flex items-center gap-1.5' }, [
      el('span', { class: 'inline-block w-3 h-3 rounded bg-yellow' }), 'Seleccionados',
    ]),
    el('span', { class: 'flex items-center gap-1.5' }, [
      el('span', { class: 'inline-block w-3 h-3 rounded bg-sky' }), 'Cola activa',
    ]),
  ]);
}

function warningBanner(text) {
  return el('div', { class: 'rounded-lg bg-crit-bg border-l-4 border-crit text-crit text-[12px] px-3 py-2 flex items-center gap-2 font-medium' }, [
    el('span', { text: '⚠' }),
    el('span', { text }),
  ]);
}
