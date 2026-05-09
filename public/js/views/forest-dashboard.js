import { el } from '../ui/el.js';
import { fmtKg, fmtDate, statusLabel, URGENCY_LABEL } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { navigate } from '../router.js';

export async function forestDashboardView() {
  const [ordersRes, lotsRes] = await Promise.all([
    api.ordersList({}),
    api.lotsList({ status: 'Ready' }),
  ]);
  const today = ordersRes.today;
  const orders = ordersRes.orders;
  const readyLots = lotsRes.lots;

  const buckets = {
    pending:    orders.filter((o) => o.status === 'Pending'),
    inFlight:   orders.filter((o) => ['Accepted', 'PartiallyAccepted', 'InProduction'].includes(o.status)),
    completed:  orders.filter((o) => o.status === 'Completed'),
    rejected:   orders.filter((o) => o.status === 'Rejected'),
    partial:    orders.filter((o) => o.status === 'PartiallyAccepted'),
  };

  const urgencies = orders
    .filter((o) => !['Completed', 'Cancelled', 'Rejected'].includes(o.status))
    .filter((o) => o.delivery_urgency === 'red' || o.delivery_urgency === 'past' || o.drying_urgency === 'red' || o.drying_urgency === 'past');

  return chrome(el('div', {}, [
    pageTitle('Tablero — Forest', `Hoy: ${today}`),

    statRow([
      stat('Pendientes',  buckets.pending.length,  'Esperando respuesta de finca'),
      stat('En curso',    buckets.inFlight.length, 'Aceptados o en producción'),
      stat('Listos en finca', readyLots.length,    'Lotes Ready para envío'),
      stat('Externos',    buckets.rejected.length + buckets.partial.length, 'Requieren PO externo'),
    ]),

    primaryCTA(),

    section('Urgencias',
      urgencies.length === 0
        ? emptyText('Sin urgencias.')
        : urgencies.map(orderRow),
    ),

    section('Lotes listos para envío',
      readyLots.length === 0
        ? emptyText('Ninguno por ahora.')
        : readyLots.map(lotRow),
    ),

    section('Pedidos en curso',
      buckets.inFlight.length === 0
        ? emptyText('Sin pedidos activos.')
        : buckets.inFlight.map(orderRow),
    ),

    section('Pedidos pendientes (esperando finca)',
      buckets.pending.length === 0
        ? emptyText('Sin pendientes.')
        : buckets.pending.map(orderRow),
    ),
  ]));
}

function statRow(items) {
  return el('div', { class: 'grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4' }, items);
}

function stat(label, value, hint) {
  return el('div', { class: 'bg-white rounded-xl border border-slate-200 px-3 py-3' }, [
    el('p', { class: 'text-xs text-slate-500', text: label }),
    el('p', { class: 'text-2xl font-semibold text-slate-900', text: String(value) }),
    el('p', { class: 'text-[11px] text-slate-400', text: hint }),
  ]);
}

function primaryCTA() {
  return el('div', { class: 'mb-4' }, [
    el('button', {
      class: 'w-full sm:w-auto px-5 py-3 rounded-lg bg-forest hover:bg-forest-dark text-white font-medium',
      onClick: () => navigate('/forest/demand'),
    }, ['+ Nuevo pedido']),
  ]);
}

function section(title, children) {
  return el('section', { class: 'mb-5' }, [
    el('h3', { class: 'text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2', text: title }),
    el('div', { class: 'space-y-2' }, children),
  ]);
}

function emptyText(t) {
  return el('p', { class: 'text-sm text-slate-400 italic px-1', text: t });
}

export function orderRow(o) {
  const urg = pickUrgency(o);
  return el('div', { class: 'bg-white rounded-xl border border-slate-200 p-3 sm:p-4' }, [
    el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-1' }, [
      el('div', { class: 'flex items-center gap-2 min-w-0' }, [
        el('span', { class: 'font-mono text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700', text: o.order_code }),
        el('span', { class: 'font-medium text-slate-900 truncate', text: o.reference_name || '—' }),
      ]),
      urg ? el('span', { class: `text-xs px-2 py-0.5 rounded urgency-${urg.kind}`, text: urg.label }) : null,
    ]),
    el('div', { class: 'flex flex-wrap text-xs text-slate-600 gap-x-4 gap-y-1' }, [
      el('span', {}, [`Estado: `, el('strong', { text: statusLabel(o.status) })]),
      el('span', {}, [`Verde: `, el('strong', { text: fmtKg(o.kg_green_required) })]),
      o.kg_green_accepted != null ? el('span', {}, [`Aceptado: `, el('strong', { text: fmtKg(o.kg_green_accepted) })]) : null,
      el('span', {}, [`Cereza: `, el('strong', { text: fmtKg(o.kg_cherry_required) })]),
      el('span', {}, [`Entrega: `, el('strong', { text: fmtDate(o.max_delivery_date) })]),
      el('span', {}, [`Drying-start: `, el('strong', { text: fmtDate(o.latest_drying_start_date) })]),
      el('span', {}, [`Proceso: `, el('strong', { text: o.process_type })]),
    ]),
  ]);
}

function lotRow(l) {
  return el('div', { class: 'bg-white rounded-xl border border-slate-200 p-3 sm:p-4' }, [
    el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-1' }, [
      el('div', { class: 'flex items-center gap-2' }, [
        el('span', { class: 'font-mono text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700', text: l.lot_code }),
        el('span', { class: 'font-medium text-slate-900', text: l.reference_name || '—' }),
      ]),
      el('span', { class: 'text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-800', text: statusLabel(l.status) }),
    ]),
    el('div', { class: 'flex flex-wrap text-xs text-slate-600 gap-x-4 gap-y-1' }, [
      el('span', {}, [`Cereza: `, el('strong', { text: fmtKg(l.kg_cherry_input) })]),
      el('span', {}, [`Verde esperado: `, el('strong', { text: fmtKg(l.kg_green_expected) })]),
      l.kg_green_actual != null ? el('span', {}, [`Verde real: `, el('strong', { text: fmtKg(l.kg_green_actual) })]) : null,
      el('span', {}, [`Listo: `, el('strong', { text: fmtDate(l.ready_date) })]),
      el('span', {}, [`Asignaciones: `, el('strong', { text: String((l.assignments || []).length) })]),
    ]),
  ]);
}

function pickUrgency(o) {
  // delivery urgency takes precedence (Forest cares about ETAs)
  const u = o.delivery_urgency === 'past' || o.delivery_urgency === 'red'
    ? o.delivery_urgency
    : o.drying_urgency;
  if (!u || u === 'normal') return null;
  return { kind: u, label: URGENCY_LABEL[u] || u };
}
