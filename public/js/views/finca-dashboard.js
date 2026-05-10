// Finca dashboard — CTRM-styled.
import { el } from '../ui/el.js';
import { fmtKg, fmtDate, statusLabel, statusPillKind, URGENCY_LABEL } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { renderCapacityPayload } from './_capacity-panel.js';
import { navigate } from '../router.js';

export async function fincaDashboardView() {
  const [ordersRes, lotsAllRes] = await Promise.all([
    api.ordersList({}),
    api.lotsList({}),
  ]);

  const today = ordersRes.today;
  const orders = ordersRes.orders;
  const lots   = lotsAllRes.lots;

  const buckets = {
    pending:        orders.filter((o) => o.status === 'Pending'),
    accepted:       orders.filter((o) => ['Accepted', 'PartiallyAccepted'].includes(o.status)),
    inProduction:   orders.filter((o) => o.status === 'InProduction'),
    ready:          lots.filter((l) => l.status === 'Ready'),
    delivered:      lots.filter((l) => l.status === 'Delivered'),
  };

  const inFlight = orders.filter((o) =>
    ['Accepted', 'PartiallyAccepted', 'InProduction'].includes(o.status));
  const urgencies = inFlight.filter((o) =>
    o.drying_urgency === 'past' || o.drying_urgency === 'red'
    || o.delivery_urgency === 'past' || o.delivery_urgency === 'red');

  let capacity = null;
  if (inFlight.length > 0) {
    try {
      capacity = await api.capacity({
        order_ids: inFlight.map((o) => o.id),
        include_active_queue: true,
      });
    } catch (e) { /* surface in section */ }
  }

  const queueByRef = new Map();
  for (const o of inFlight) {
    const key = o.reference_name || '—';
    if (!queueByRef.has(key)) queueByRef.set(key, { kg_green: 0, kg_cherry: 0, count: 0, orders: [] });
    const b = queueByRef.get(key);
    const kg = Number(o.kg_green_accepted ?? o.kg_green_required ?? 0);
    b.kg_green  += kg;
    b.kg_cherry += Number(o.kg_cherry_accepted ?? o.kg_cherry_required ?? 0);
    b.count     += 1;
    b.orders.push(o);
  }

  return chrome(el('div', {}, [
    pageTitle('Tablero El Vergel', `Hoy: ${today}`),

    statRow([
      stat('Pendientes',     buckets.pending.length,      'Por aceptar', () => navigate('/finca/inbox')),
      stat('Aceptados',      buckets.accepted.length,     'Sin lote aún', () => navigate('/finca/lots')),
      stat('En producción',  buckets.inProduction.length, 'Con lote asignado', () => navigate('/finca/lots'), { kind: 'roll' }),
      stat('Listos / entregados', `${buckets.ready.length} / ${buckets.delivered.length}`, 'Lotes', () => navigate('/finca/lots'), { kind: 'ok' }),
    ]),

    section('Urgencias',
      urgencies.length === 0
        ? emptyText('Sin urgencias.')
        : urgencies.map(orderRow),
    ),

    section('Cola activa por referencia',
      queueByRef.size === 0
        ? emptyText('Sin pedidos en curso.')
        : [...queueByRef.entries()]
            .sort((a, b) => b[1].kg_cherry - a[1].kg_cherry)
            .map(([ref, b]) => referenceQueueCard(ref, b)),
    ),

    section('Carga semanal',
      capacity
        ? el('div', { class: 'ctrm-card ctrm-card-pad' }, [renderCapacityPayload(capacity, { showOrders: false })])
        : emptyText('Sin pedidos para calcular carga.'),
    ),
  ]));
}

function statRow(items) {
  return el('div', { class: 'grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5' }, items);
}

function stat(label, value, hint, onClick, opts = {}) {
  const valClass = opts.kind ? `stat-val ${opts.kind}` : 'stat-val';
  return el('button', {
    class: 'stat-card is-clickable text-left',
    type: 'button', onClick: onClick || (() => {}),
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

function orderRow(o) {
  const u = o.drying_urgency === 'past' || o.drying_urgency === 'red'
    ? o.drying_urgency : o.delivery_urgency;
  const badge = u && u !== 'normal'
    ? el('span', { class: `ctrm-pill urgency-${u}`, text: URGENCY_LABEL[u] || u })
    : null;
  return el('div', { class: 'ctrm-card ctrm-card-pad' }, [
    el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-2' }, [
      el('div', { class: 'flex items-center gap-2 min-w-0 flex-wrap' }, [
        el('span', { class: 'ctrm-code', text: o.order_code }),
        el('span', { class: 'font-display font-semibold text-navy text-[13px] truncate', text: o.reference_name || '—' }),
      ]),
      badge,
    ]),
    el('div', { class: 'flex flex-wrap text-[12px] text-ink-500 gap-x-4 gap-y-1 font-mono' }, [
      meta('Estado', statusLabel(o.status)),
      meta('Cereza', fmtKg(o.kg_cherry_accepted ?? o.kg_cherry_required)),
      meta('Inicio drying', fmtDate(o.latest_drying_start_date)),
      meta('Entrega', fmtDate(o.max_delivery_date)),
      meta('Proceso', o.process_type),
    ]),
  ]);
}

function meta(label, value) {
  return el('span', { class: 'inline-flex items-baseline gap-1' }, [
    el('span', { class: 'text-ink-300 uppercase tracking-loose text-[10px] font-sans font-semibold', text: label }),
    el('strong', { class: 'text-ink-700 font-mono', text: value }),
  ]);
}

function referenceQueueCard(refName, b) {
  return el('div', { class: 'ctrm-card ctrm-card-pad' }, [
    el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-1' }, [
      el('span', { class: 'font-display font-semibold text-navy text-[13px]', text: refName }),
      el('span', { class: 'ctrm-pill muted', text: `${b.count} pedido${b.count===1?'':'s'}` }),
    ]),
    el('div', { class: 'flex flex-wrap text-[12px] text-ink-500 gap-x-4 gap-y-1 font-mono' }, [
      meta('Verde total', fmtKg(b.kg_green)),
      meta('Cereza total', fmtKg(b.kg_cherry)),
    ]),
    el('div', { class: 'flex flex-wrap gap-1 mt-2' }, b.orders.map((o) =>
      el('span', { class: 'ctrm-code', text: o.order_code }),
    )),
  ]);
}
