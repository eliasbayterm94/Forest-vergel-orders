// Finca dashboard:
// - Stat cards (pending / accepted / in production / ready / delivered)
// - Active queue grouped by reference, kg cereza required
// - Urgencies (drying past/red, delivery red)
// - Weekly capacity load (all in-flight orders + active queue)
import { el } from '../ui/el.js';
import { fmtKg, fmtDate, statusLabel, URGENCY_LABEL } from '../ui/format.js';
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

  // Capacity payload for in-flight orders + active queue overlay
  let capacity = null;
  if (inFlight.length > 0) {
    try {
      capacity = await api.capacity({
        order_ids: inFlight.map((o) => o.id),
        include_active_queue: true,
      });
    } catch (e) { /* surface in section */ }
  }

  // Group active queue by reference (kg cereza required)
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
    pageTitle('Tablero — El Vergel', `Hoy: ${today}`),

    statRow([
      stat('Pendientes',     buckets.pending.length,      'Por aceptar', () => navigate('/finca/inbox')),
      stat('Aceptados',      buckets.accepted.length,     'Sin lote aún', () => navigate('/finca/lots')),
      stat('En producción',  buckets.inProduction.length, 'Con lote asignado', () => navigate('/finca/lots')),
      stat('Listos / entregados', `${buckets.ready.length} / ${buckets.delivered.length}`, 'Lotes', () => navigate('/finca/lots')),
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
        ? renderCapacityPayload(capacity, { showOrders: false })
        : emptyText('Sin pedidos para calcular carga.'),
    ),
  ]));
}

function statRow(items) {
  return el('div', { class: 'grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4' }, items);
}

function stat(label, value, hint, onClick) {
  return el('button', {
    class: 'text-left bg-white rounded-xl border border-slate-200 px-3 py-3 hover:border-forest hover:shadow-sm transition',
    type: 'button', onClick: onClick || (() => {}),
  }, [
    el('p', { class: 'text-xs text-slate-500', text: label }),
    el('p', { class: 'text-2xl font-semibold text-slate-900', text: String(value) }),
    el('p', { class: 'text-[11px] text-slate-400', text: hint }),
  ]);
}

function section(title, children) {
  return el('section', { class: 'mb-5' }, [
    el('h3', { class: 'text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2', text: title }),
    Array.isArray(children)
      ? el('div', { class: 'space-y-2' }, children)
      : el('div', { class: 'bg-white rounded-xl border border-slate-200 p-3 sm:p-4' }, [children]),
  ]);
}

function emptyText(t) {
  return el('p', { class: 'text-sm text-slate-400 italic px-1', text: t });
}

function orderRow(o) {
  const u = o.drying_urgency === 'past' || o.drying_urgency === 'red'
    ? o.drying_urgency : o.delivery_urgency;
  const badge = u && u !== 'normal'
    ? el('span', { class: `text-xs px-2 py-0.5 rounded urgency-${u}`, text: URGENCY_LABEL[u] || u })
    : null;
  return el('div', { class: 'bg-white rounded-xl border border-slate-200 p-3 sm:p-4' }, [
    el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-1' }, [
      el('div', { class: 'flex items-center gap-2 min-w-0' }, [
        el('span', { class: 'font-mono text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700', text: o.order_code }),
        el('span', { class: 'font-medium text-slate-900 truncate', text: o.reference_name || '—' }),
      ]),
      badge,
    ]),
    el('div', { class: 'flex flex-wrap text-xs text-slate-600 gap-x-4 gap-y-1' }, [
      el('span', {}, [`Estado: `, el('strong', { text: statusLabel(o.status) })]),
      el('span', {}, [`Cereza: `, el('strong', { text: fmtKg(o.kg_cherry_accepted ?? o.kg_cherry_required) })]),
      el('span', {}, [`Inicio drying: `, el('strong', { text: fmtDate(o.latest_drying_start_date) })]),
      el('span', {}, [`Entrega: `, el('strong', { text: fmtDate(o.max_delivery_date) })]),
      el('span', {}, [`Proceso: `, el('strong', { text: o.process_type })]),
    ]),
  ]);
}

function referenceQueueCard(refName, b) {
  return el('div', { class: 'bg-white rounded-xl border border-slate-200 p-3 sm:p-4' }, [
    el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-1' }, [
      el('span', { class: 'font-medium text-slate-900', text: refName }),
      el('span', { class: 'text-xs text-slate-500', text: `${b.count} pedido(s)` }),
    ]),
    el('div', { class: 'flex flex-wrap text-xs text-slate-700 gap-x-4 gap-y-1' }, [
      el('span', {}, [`Verde total: `, el('strong', { text: fmtKg(b.kg_green) })]),
      el('span', {}, [`Cereza total: `, el('strong', { text: fmtKg(b.kg_cherry) })]),
    ]),
    el('div', { class: 'flex flex-wrap gap-1 text-[11px] mt-1' }, b.orders.map((o) =>
      el('span', { class: 'font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-700', text: o.order_code }),
    )),
  ]);
}
