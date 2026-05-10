// Finca dashboard — CTRM-styled.
import { el } from '../ui/el.js';
import { fmtKg, fmtDate, statusLabel, statusPillKind, URGENCY_LABEL } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { renderCapacityPayload } from './_capacity-panel.js';
import { navigate } from '../router.js';

export async function fincaDashboardView() {
  const [ordersRes, lotsAllRes, shipsRes] = await Promise.all([
    api.ordersList({}),
    api.lotsList({}),
    api.shipmentsList(),
  ]);

  const today = ordersRes.today;
  const orders = ordersRes.orders;
  const lots   = lotsAllRes.lots;
  const shipments = shipsRes.shipments || [];

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

  // ── Second-row metrics (production-focused) ─────────────────────
  // 1) Cereza pendiente de procesar = sum of (kg_green_accepted - allocations
  //    from non-Delivered lots) across in-flight orders, × 7.65.
  const allocByOrder = new Map();
  for (const lot of lots) {
    if (lot.status === 'Delivered') continue;
    for (const a of lot.assignments || []) {
      allocByOrder.set(a.demand_order_id, (allocByOrder.get(a.demand_order_id) || 0) + Number(a.kg_green_allocated || 0));
    }
  }
  const kgGreenPending = inFlight.reduce((s, o) => {
    const accepted = Number(o.kg_green_accepted || 0);
    const allocated = allocByOrder.get(o.id) || 0;
    return s + Math.max(0, accepted - allocated);
  }, 0);
  const kgCherryPending = kgGreenPending * 7.65;

  // 2) Listos sin despachar = Ready lots not in any shipment.
  const shippedLotIds = new Set();
  shipments.forEach((s) => (s.lots || []).forEach((l) => shippedLotIds.add(l.id)));
  const readyUnshipped = lots.filter((l) => l.status === 'Ready' && !shippedLotIds.has(l.id));

  // 3) kg verde despachado este mes (current calendar month, Bogota).
  const mesKey = today.slice(0, 7);
  const verdeDespachadoMes = shipments
    .filter((s) => (s.shipment_date || '').slice(0, 7) === mesKey)
    .reduce((s, x) => s + Number(x.totals?.kg_green || 0), 0);

  // 4) Factor promedio de los últimos 30 días.
  const thirtyDaysAgo = isoDateNDaysAgo(today, 30);
  const recentDelivered = lots.filter((l) =>
    l.status === 'Delivered'
    && (l.delivered_date || '') >= thirtyDaysAgo
    && l.factor_rendimiento != null
  );
  const factorPromedio = recentDelivered.length > 0
    ? recentDelivered.reduce((s, l) => s + Number(l.factor_rendimiento || 0), 0) / recentDelivered.length
    : null;

  return chrome(el('div', {}, [
    pageTitle('Tablero El Vergel', `Hoy: ${today}`),

    // Row 1: status counts (existing)
    statRow([
      stat('Pendientes',     buckets.pending.length,      'Por aceptar', () => navigate('/finca/inbox')),
      stat('Aceptados',      buckets.accepted.length,     'Sin lote aún', () => navigate('/finca/lots')),
      stat('En producción',  buckets.inProduction.length, 'Con lote asignado', () => navigate('/finca/lots'), { kind: 'roll' }),
      stat('Listos / entregados', `${buckets.ready.length} / ${buckets.delivered.length}`, 'Lotes', () => navigate('/finca/lots'), { kind: 'ok' }),
    ]),

    // Row 2: production metrics
    statRow([
      stat('Cereza por procesar', fmtKg(kgCherryPending), `${fmtKg(kgGreenPending)} verde sin asignar`, null, { kind: kgCherryPending > 0 ? 'warn' : 'ok' }),
      stat('Listos sin despachar', readyUnshipped.length, readyUnshipped.length > 0 ? 'Crear despacho' : 'Al día', () => navigate('/finca/despachos'), { kind: readyUnshipped.length > 0 ? 'warn' : 'ok' }),
      stat('Despachado este mes',  fmtKg(verdeDespachadoMes), `${shipments.filter((s) => (s.shipment_date||'').slice(0,7) === mesKey).length} despacho(s)`, () => navigate('/finca/despachos')),
      stat('Factor promedio (30d)', factorPromedio != null ? factorPromedio.toFixed(2) : '—', `${recentDelivered.length} lote(s) recientes`, null),
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

// Returns the YYYY-MM-DD that is `days` calendar days before `today`.
function isoDateNDaysAgo(today, days) {
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
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
