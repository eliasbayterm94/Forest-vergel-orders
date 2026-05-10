import { el } from '../ui/el.js';
import { fmtKg, fmtDate, statusLabel, statusPillKind, URGENCY_LABEL } from '../ui/format.js';
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
    pageTitle('Tablero Forest', `Hoy: ${today}`),

    statRow([
      stat('Pendientes',  buckets.pending.length,  'Esperando finca'),
      stat('En curso',    buckets.inFlight.length, 'Aceptados / producción'),
      stat('Listos',      readyLots.length,        'Lotes para envío', { kind: 'ok' }),
      stat('Externos',    buckets.rejected.length + buckets.partial.length, 'Requieren PO', { kind: buckets.rejected.length + buckets.partial.length > 0 ? 'crit' : 'ok' }),
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
  return el('div', { class: 'grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5' }, items);
}

function stat(label, value, hint, opts = {}) {
  const valClass = opts.kind ? `stat-val ${opts.kind}` : 'stat-val';
  return el('div', { class: 'stat-card' }, [
    el('p', { class: 'stat-label', text: label }),
    el('p', { class: valClass, text: String(value) }),
    el('p', { class: 'stat-sub', text: hint }),
  ]);
}

function primaryCTA() {
  return el('div', { class: 'mb-5' }, [
    el('button', {
      class: 'ctrm-btn ctrm-btn-yellow w-full sm:w-auto uppercase tracking-eyebrow text-[11px] py-3 px-6',
      onClick: () => navigate('/forest/demand'),
    }, ['+ Nuevo pedido']),
  ]);
}

function section(title, children) {
  return el('section', { class: 'mb-6' }, [
    el('h3', { class: 'eyebrow mb-2', text: title }),
    el('div', { class: 'space-y-2' }, children),
  ]);
}

function emptyText(t) {
  return el('p', { class: 'text-[12px] text-ink-300 italic px-1', text: t });
}

export function orderRow(o) {
  const urg = pickUrgency(o);
  return el('div', { class: 'ctrm-card ctrm-card-pad' }, [
    el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-2' }, [
      el('div', { class: 'flex items-center gap-2 min-w-0 flex-wrap' }, [
        el('span', { class: 'ctrm-code', text: o.order_code }),
        el('span', { class: 'font-display font-semibold text-navy text-[13px] truncate', text: o.reference_name || '—' }),
        o.order_type ? el('span', { class: 'ctrm-pill dark', text: o.order_type }) : null,
        el('span', { class: `ctrm-pill ${statusPillKind(o.status)}`, text: statusLabel(o.status) }),
      ]),
      urg ? el('span', { class: `ctrm-pill urgency-${urg.kind}`, text: urg.label }) : null,
    ]),
    (o.client_name || (o.regions && o.regions.length) || o.contract_code)
      ? el('div', { class: 'flex flex-wrap text-[11px] text-ink-500 gap-x-3 gap-y-0.5 mb-1.5' }, [
          o.client_name  ? meta('Cliente', o.client_name) : null,
          o.regions && o.regions.length ? meta('Regiones', o.regions.join(' · ')) : null,
          o.contract_code ? meta('Contrato', o.contract_code) : null,
        ])
      : null,
    el('div', { class: 'flex flex-wrap text-[12px] text-ink-500 gap-x-4 gap-y-1 font-mono' }, [
      meta('Verde', fmtKg(o.kg_green_required)),
      o.kg_green_accepted != null ? meta('Aceptado', fmtKg(o.kg_green_accepted)) : null,
      meta('Cereza', fmtKg(o.kg_cherry_required)),
      meta('Entrega', fmtDate(o.max_delivery_date)),
      meta('Drying-start', fmtDate(o.latest_drying_start_date)),
      meta('Proceso', o.process_type),
    ]),
  ]);
}

function lotRow(l) {
  return el('div', { class: 'ctrm-card ctrm-card-pad' }, [
    el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-2' }, [
      el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
        el('span', { class: 'ctrm-code', text: l.lot_code }),
        el('span', { class: 'font-display font-semibold text-navy text-[13px]', text: l.reference_name || '—' }),
        el('span', { class: 'ctrm-pill ok', text: statusLabel(l.status) }),
      ]),
    ]),
    el('div', { class: 'flex flex-wrap text-[12px] text-ink-500 gap-x-4 gap-y-1 font-mono' }, [
      meta('Cereza', fmtKg(l.kg_cherry_input)),
      meta('Verde esperado', fmtKg(l.kg_green_expected)),
      l.kg_green_actual != null ? meta('Verde real', fmtKg(l.kg_green_actual)) : null,
      meta('Listo', fmtDate(l.ready_date)),
      meta('Asignaciones', String((l.assignments || []).length)),
    ]),
  ]);
}

function meta(label, value) {
  return el('span', { class: 'inline-flex items-baseline gap-1' }, [
    el('span', { class: 'text-ink-300 uppercase tracking-loose text-[10px] font-sans font-semibold', text: label }),
    el('strong', { class: 'text-ink-700 font-mono', text: value }),
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
