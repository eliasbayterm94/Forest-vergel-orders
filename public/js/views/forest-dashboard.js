import { el, clear } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { openModal, confirmModal } from '../ui/modal.js';
import { createCombobox, createMultiCombobox } from '../ui/combobox.js';
import { fmtKg, fmtDate, statusLabel, statusPillKind, URGENCY_LABEL, relDate } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { navigate, currentQuery, updateHashQuery } from '../router.js';
import { emptyStateCard } from '../ui/empty.js';
import { createViewMode } from '../ui/view-mode.js';
import { renderFilterButton } from '../ui/filters-sheet.js';
import { createTabBar } from '../ui/tab-bar.js';

const PHYSICAL_ASPECTS = ['Verde', 'Verde amarillo', 'Amarillo', 'Amarillo-Marrón', 'Parduzco'];
const PROCESS_TYPES    = ['Natural', 'Honey', 'Lavado'];
const ORDER_TYPES      = ['Spot', 'Contract', 'FOB'];
const REGIONS          = ['USA', 'EU', 'UK', 'MENA', 'AU'];

export async function forestDashboardView() {
  const [ordersRes, lotsRes, shipsRes, refsRes, varsRes] = await Promise.all([
    api.ordersList({}),
    api.lotsList({}),   // todos: incluye Delivered para rollup correcto
    api.shipmentsList(),
    api.references(),
    api.varieties(),
  ]);
  const today = ordersRes.today;
  const orders = ordersRes.orders;
  const allLots = lotsRes.lots;
  const shipments = shipsRes.shipments || [];
  const readyLots = allLots.filter((l) => l.status === 'Ready');
  const allReferences = refsRes.references;
  const allVarieties  = varsRes.varieties;

  // Despachos por pedido (que despachos cubrieron este pedido y con
  // cuanto kg). Se calcula desde shipments.lots[].assignments para
  // mostrar chips inline en cada card de pedido en curso.
  const shipmentsByOrder = new Map();   // order_id → [{code, date, kg}]
  for (const s of shipments) {
    for (const lot of s.lots || []) {
      for (const a of lot.assignments || []) {
        const oid = a.order?.id;
        if (!oid) continue;
        if (!shipmentsByOrder.has(oid)) shipmentsByOrder.set(oid, []);
        shipmentsByOrder.get(oid).push({
          code: s.shipment_code,
          date: s.shipment_date,
          kg:   Number(a.kg_green_allocated || 0),
        });
      }
    }
  }

  // Per-order rollup: cuanto del kg aceptado ya esta cubierto por
  // lotes (incluyendo Delivered, agrupados como "delivered"). Si no
  // contamos Delivered, un pedido entregado en parte aparece como
  // pendiente esa parte y se sobre-asigna.
  // Despachos por lote (para mostrarlos en el dropdown de baches por
  // pedido). shipments[].lots[].id es el lot_id.
  const shipmentsByLot = new Map();
  for (const s of shipments) {
    for (const lot of s.lots || []) {
      if (!shipmentsByLot.has(lot.id)) shipmentsByLot.set(lot.id, []);
      shipmentsByLot.get(lot.id).push({ code: s.shipment_code, date: s.shipment_date });
    }
  }

  const orderRollup = new Map();
  for (const lot of allLots) {
    for (const a of lot.assignments || []) {
      const oid = a.demand_order_id;
      const kg = Number(a.kg_green_allocated || 0);
      if (!orderRollup.has(oid)) orderRollup.set(oid, {
        ready: 0, drying: 0, fermentation: 0, delivered: 0, total: 0, lots: [],
      });
      const r = orderRollup.get(oid);
      r.total += kg;
      if (lot.status === 'Ready')               r.ready += kg;
      else if (lot.status === 'Drying')         r.drying += kg;
      else if (lot.status === 'InFermentation') r.fermentation += kg;
      else if (lot.status === 'Delivered')      r.delivered += kg;
      r.lots.push({
        id: lot.id,
        code: lot.bache_code || lot.lot_code,
        bache_code: lot.bache_code,
        lot_code: lot.lot_code,
        status: lot.status,
        process_type: lot.process_type,
        factor_rendimiento: lot.factor_rendimiento,
        kg_dried_output: lot.kg_dried_output,
        varieties: (lot.varieties || []).map((v) => v.name),
        shipments: shipmentsByLot.get(lot.id) || [],
        kg,
      });
    }
  }

  // Tracking por pedido: desglose explicito del ciclo de vida.
  //   enProceso        — kg asignados en lotes InFermentation/Drying
  //   readyOrDelivered — kg asignados en lotes Ready o Delivered (de aqui
  //                      se descuenta lo despachado para obtener "listo")
  //   despachado se calcula desde shipmentsByOrder.
  const trackingByOrder = new Map();
  for (const lot of allLots) {
    for (const a of lot.assignments || []) {
      const oid = a.demand_order_id;
      const kg = Number(a.kg_green_allocated || 0);
      if (!trackingByOrder.has(oid)) trackingByOrder.set(oid, { enProceso: 0, readyOrDelivered: 0 });
      const t = trackingByOrder.get(oid);
      if (lot.status === 'InFermentation' || lot.status === 'Drying') t.enProceso += kg;
      else if (lot.status === 'Ready' || lot.status === 'Delivered') t.readyOrDelivered += kg;
    }
  }

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

  // Renderer factory: pending rows get Editar/Cancelar actions; others don't.
  const actionsFor = (o) => o.status === 'Pending' ? [
    { label: 'Editar',  variant: 'soft',   onClick: () => openEditOrder(o) },
    { label: 'Cancelar', variant: 'danger', onClick: () => openCancelOrder(o) },
  ] : null;
  const rowFor = (o) => orderRow(o, {
    rollup: orderRollup.get(o.id) || null,
    shipments: shipmentsByOrder.get(o.id) || [],
    actions: actionsFor(o),
  });

  const root = el('div', {});
  const vm = createViewMode('forest-dashboard', { onChange: () => redraw() });
  function renderList(items, opts) {
    if (vm.mode() === 'table') return ordersTable(items, orderRollup, shipmentsByOrder, { ...(opts || {}), actionsFor });
    return el('div', { class: 'space-y-2' }, items.map(rowFor));
  }

  // ── Selector de seccion (focus en una a la vez) ─────────────────
  const SECTIONS = [
    { key: 'urgencias',   label: 'Urgencias',   count: urgencies.length },
    { key: 'listos',      label: 'Lotes Listos',count: readyLots.length },
    { key: 'inflight',    label: 'En curso',    count: buckets.inFlight.length },
    { key: 'pending',     label: 'Pendientes',  count: buckets.pending.length },
    { key: 'seguimiento', label: 'Seguimiento', count: buckets.inFlight.length + buckets.pending.length },
  ];
  const initialSection = (currentQuery().get('section') && SECTIONS.find((s) => s.key === currentQuery().get('section')))
    ? currentQuery().get('section')
    : (urgencies.length > 0 ? 'urgencias' : 'inflight');
  let activeSection = initialSection;

  function renderSectionContent() {
    if (activeSection === 'urgencias') {
      return urgencies.length === 0
        ? emptyStateCard({ title: 'Todo al día', description: 'Ningún pedido está en zona crítica.' })
        : renderList(urgencies);
    }
    if (activeSection === 'listos') {
      return readyLots.length === 0
        ? emptyStateCard({ title: 'Sin lotes Listos', description: 'Aparecerán aquí cuando finca cierre el bache.' })
        : (vm.mode() === 'table' ? lotsTable(readyLots) : el('div', { class: 'space-y-2' }, readyLots.map(lotRow)));
    }
    if (activeSection === 'inflight') {
      return buckets.inFlight.length === 0
        ? emptyStateCard({
            title: 'Sin pedidos activos',
            description: 'Crea uno para que finca lo revise.',
            action: { label: '+ Nuevo pedido', onClick: () => navigate('/forest/demand') },
          })
        : renderList(buckets.inFlight);
    }
    if (activeSection === 'pending') {
      return buckets.pending.length === 0
        ? emptyStateCard({ title: 'Sin pendientes', description: 'Todos los pedidos creados ya fueron contestados por finca.' })
        : renderList(buckets.pending, { withActions: true });
    }
    if (activeSection === 'seguimiento') {
      return renderSeguimiento();
    }
    return null;
  }

  // ── Seguimiento section ──────────────────────────────────────────
  let seguimientoFilters = {};
  let showHistorical = false;
  const expandedSeg = new Set();   // order_ids expandidos para ver lotes
  const toggleSeg = (orderId) => {
    if (expandedSeg.has(orderId)) expandedSeg.delete(orderId);
    else expandedSeg.add(orderId);
    redraw();
  };
  const clientOptions = [...new Set(orders.map((o) => o.client_name).filter(Boolean))].sort();
  const regionOptions = [...new Set(orders.flatMap((o) => o.regions || []).filter(Boolean))].sort();
  const refOptions    = [...new Set(orders.map((o) => o.reference_name).filter(Boolean))].sort();

  const ACTIVE_STATUSES = ['Accepted', 'PartiallyAccepted', 'InProduction'];
  const HISTORICAL_STATUSES = ['Completed', 'Cancelled', 'Rejected'];

  const SEG_FILTERS = [
    { key: 'client_name', label: 'Cliente',    multi: true,  options: clientOptions, getter: (o) => o.client_name || '' },
    { key: 'region',      label: 'Región',     multi: true,  options: regionOptions, getter: (o) => (o.regions || []).join(',') }, // see below
    { key: 'reference',   label: 'Referencia', multi: true,  options: refOptions,    getter: (o) => o.reference_name || '' },
    { key: 'status',      label: 'Status',     multi: true,  options: ['Accepted','PartiallyAccepted','InProduction','Completed','Cancelled','Rejected'],
      optionLabels: { Accepted:'Aceptado', PartiallyAccepted:'Aceptado parcial', InProduction:'En producción',
                      Completed:'Completado', Cancelled:'Cancelado', Rejected:'Rechazado' },
      getter: (o) => o.status },
  ];

  function passesSeg(o) {
    for (const f of SEG_FILTERS) {
      const v = seguimientoFilters[f.key];
      if (!v || v.length === 0) continue;
      if (f.key === 'region') {
        // Coincide si alguna region del pedido esta seleccionada
        if (!(o.regions || []).some((r) => v.includes(r))) return false;
      } else {
        if (!v.includes(f.getter(o))) return false;
      }
    }
    return true;
  }

  function renderSeguimiento() {
    const statusPool = showHistorical
      ? [...ACTIVE_STATUSES, ...HISTORICAL_STATUSES]
      : ACTIVE_STATUSES;
    const rows = orders
      .filter((o) => statusPool.includes(o.status))
      .filter(passesSeg)
      .map((o) => {
        const t = trackingByOrder.get(o.id) || { enProceso: 0, readyOrDelivered: 0 };
        const ships = shipmentsByOrder.get(o.id) || [];
        const despachado = ships.reduce((s, x) => s + Number(x.kg || 0), 0);
        const listo = Math.max(0, t.readyOrDelivered - despachado);
        const aceptado = Number(o.kg_green_accepted || 0);
        const saldo = aceptado - (t.enProceso + listo + despachado);
        const isClosed = o.status === 'Completed' || o.status === 'Cancelled' || o.status === 'Rejected'
          || (aceptado > 0 && despachado + 0.001 >= aceptado);
        return { o, aceptado, enProceso: t.enProceso, listo, despachado, saldo, isClosed };
      })
      .sort((a, b) => {
        // Activos primero por max_delivery_date asc, luego histórico
        const aHist = HISTORICAL_STATUSES.includes(a.o.status);
        const bHist = HISTORICAL_STATUSES.includes(b.o.status);
        if (aHist !== bHist) return aHist ? 1 : -1;
        return (a.o.max_delivery_date || '').localeCompare(b.o.max_delivery_date || '');
      });

    const fb = renderFilterButton({
      filters: SEG_FILTERS,
      values: seguimientoFilters,
      onChange: (v) => { seguimientoFilters = v; redraw(); },
    });
    const histBtn = el('button', {
      type: 'button',
      class: showHistorical
        ? 'ctrm-btn ctrm-btn-primary ctrm-btn-sm'
        : 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
      onClick: () => { showHistorical = !showHistorical; redraw(); },
    }, [showHistorical ? '✓ Histórico visible' : 'Mostrar histórico']);

    return el('div', {}, [
      el('div', { class: 'flex flex-wrap items-center gap-2 mb-3' }, [fb.el, histBtn]),
      rows.length === 0
        ? emptyStateCard({
            title: 'Sin pedidos que mostrar',
            description: showHistorical
              ? 'Ningún pedido coincide con el filtro actual.'
              : 'Cuando se acepten pedidos los verás aquí. Activa "Mostrar histórico" para ver pedidos cerrados.',
          })
        : (vm.mode() === 'table'
            ? seguimientoTable(rows, orderRollup, shipmentsByOrder, expandedSeg, toggleSeg)
            : el('div', { class: 'space-y-2' }, rows.map((r) =>
                seguimientoCard(r, orderRollup, shipmentsByOrder, expandedSeg, toggleSeg)))),
    ]);
  }

  function redraw() {
    clear(root);
    const tabbar = createTabBar({
      tabs: SECTIONS.map((s) => ({ key: s.key, label: s.label, count: s.count })),
      activeKey: activeSection,
      onChange: (key) => {
        activeSection = key;
        updateHashQuery({ section: key === initialSection ? null : key });
        redraw();
      },
    });
    tabbar.setContent(renderSectionContent());

    const ctaNuevoPedido = el('button', {
      class: 'ctrm-btn ctrm-btn-yellow uppercase tracking-eyebrow text-[11px]',
      onClick: () => navigate('/forest/demand'),
    }, ['+ Nuevo pedido']);
    const ctaAgregarVarios = el('button', {
      class: 'ctrm-btn ctrm-btn-soft uppercase tracking-eyebrow text-[11px]',
      title: 'Crea varios pedidos a la vez en una tabla',
      onClick: () => navigate('/forest/demand-bulk'),
    }, ['+ Agregar varios']);
    const ctaGroup = el('div', { class: 'flex flex-wrap gap-2' }, [ctaAgregarVarios, ctaNuevoPedido]);

    root.append(
      pageTitle('Tablero Forest', `Hoy: ${today}`, ctaGroup),
      statRow([
        stat('Pendientes',  buckets.pending.length,  'Esperando finca'),
        stat('En curso',    buckets.inFlight.length, 'Aceptados / producción'),
        stat('Listos',      readyLots.length,        'Lotes para envío', { kind: 'ok' }),
        stat('Externos',    buckets.rejected.length + buckets.partial.length, 'Requieren PO', { kind: buckets.rejected.length + buckets.partial.length > 0 ? 'crit' : 'ok' }),
      ]),
      el('div', { class: 'flex justify-end mb-2' }, [vm.toggleEl]),
      tabbar.el,
      tabbar.panel,
    );
  }
  redraw();
  const view = chrome(root);

  // ─── Edit modal ──────────────────────────────────────────────────
  async function openEditOrder(order) {
    const result = await openOrderEditModal(order, allReferences, allVarieties);
    if (!result) return;
    await trySaveEdit(order, result, false);
  }

  async function trySaveEdit(order, payload, override) {
    try {
      await api.orderUpdate({
        order_id: order.id,
        fields: payload.fields,
        override_15_day: override,
      });
      toast(`Pedido ${order.order_code} actualizado`, 'success');
      // Trigger a re-fetch by re-navigating to the same route.
      // Simplest: location.reload() — keeps the user on the dashboard.
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (e) {
      if (e.code === 'FIFTEEN_DAY_RULE') {
        const days = e.detail?.days_to_delivery;
        const ok = await confirmModal(
          `La fecha de entrega es en ${days} día(s) (menos de 15). ¿Ya se confirmó con la planta de producción?`,
          { title: '⚠️ Plazo corto', confirmText: 'Confirmado, guardar', danger: true },
        );
        if (ok) await trySaveEdit(order, payload, true);
      } else {
        toast(e.message || 'Error al actualizar pedido', 'error');
      }
    }
  }

  async function openCancelOrder(order) {
    const result = await openCancelModal(order);
    if (!result) return;
    try {
      await api.orderCancel({ order_id: order.id, reason: result.reason || null });
      toast(`Pedido ${order.order_code} cancelado`, 'success');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (e) { toast(e.message || 'Error al cancelar', 'error'); }
  }

  return view;
}

// ─── Table renderers ────────────────────────────────────────────────
function ordersTable(orders, rollupMap, shipmentsMap, opts = {}) {
  const actionsFor = typeof opts.actionsFor === 'function' ? opts.actionsFor : () => null;
  const anyActions = orders.some((o) => (actionsFor(o) || []).length > 0);
  const wrap = el('div', { class: 'overflow-x-auto ctrm-card' });
  const cell = (label, classes, content) => {
    const td = el('td', { class: classes });
    td.setAttribute('data-label', label);
    if (content instanceof Node) td.append(content);
    else if (Array.isArray(content)) td.append(...content.filter(Boolean));
    else td.append(document.createTextNode(String(content == null ? '—' : content)));
    return td;
  };
  // Colspan total para la fila expandible de baches (debajo de cada pedido).
  const COLSPAN = 10 + (anyActions ? 1 : 0);
  const tbody = el('tbody', {});
  for (const o of orders) {
      const r = rollupMap?.get(o.id);
      const total = r ? Number(r.total || 0) : 0;
      const accepted = Number(o.kg_green_accepted ?? o.kg_green_required ?? 0);
      const ships = shipmentsMap?.get(o.id) || [];
      const shippedKg = ships.reduce((s, x) => s + Number(x.kg || 0), 0);
      const actions = actionsFor(o) || [];
      const actionsCell = anyActions
        ? cell('Acciones', 'text-right', actions.length > 0
            ? el('div', { class: 'inline-flex gap-1 flex-wrap justify-end' }, actions.map((a) =>
                el('button', {
                  class: `ctrm-btn ctrm-btn-${a.variant === 'danger' ? 'danger' : 'soft'} ctrm-btn-xs`,
                  type: 'button',
                  onClick: (e) => { e.stopPropagation(); a.onClick(); },
                }, [a.label])))
            : '—')
        : null;

      // Dropdown de baches asignados. La fila expandible se monta hidden
      // y el botón en la columna "Baches" la despliega.
      const assignedLots = (r && r.lots) || [];
      let detailRow = null;
      let bachesCell;
      if (assignedLots.length > 0) {
        detailRow = el('tr', { hidden: 'true', class: 'bg-cream' }, [
          el('td', { colspan: String(COLSPAN), class: 'p-3' }, [assignedLotsDetail(assignedLots)]),
        ]);
        let expanded = false;
        const btn = el('button', {
          type: 'button',
          class: 'ctrm-btn ctrm-btn-ghost ctrm-btn-xs',
          onClick: (e) => {
            e.stopPropagation();
            expanded = !expanded;
            if (expanded) { detailRow.removeAttribute('hidden'); btn.textContent = `▴ ${assignedLots.length}`; }
            else          { detailRow.setAttribute('hidden', 'true'); btn.textContent = `▾ ${assignedLots.length}`; }
          },
          title: 'Ver baches asignados',
        }, [`▾ ${assignedLots.length}`]);
        bachesCell = cell('Baches', 'text-center', btn);
      } else {
        bachesCell = cell('Baches', 'text-center text-ink-300', '—');
      }

      tbody.append(el('tr', {}, [
        cell('Código', 'font-mono text-navy font-semibold', o.order_code),
        cell('Referencia', '', o.reference_name || '—'),
        cell('Cliente', '', o.client_name || '—'),
        cell('Status', '', el('span', { class: `ctrm-pill ${statusPillKind(o.status)}`, text: statusLabel(o.status) })),
        cell('Aceptado', 'text-right font-mono', fmtKg(accepted)),
        cell('Asignado', 'text-right font-mono', accepted > 0 ? `${fmtKg(total)} (${Math.round(total/accepted*100)}%)` : fmtKg(total)),
        cell('Despachado', 'text-right font-mono',
          shippedKg > 0
            ? el('span', { style: 'color:#3a6f4a;font-weight:600;' }, [`${fmtKg(shippedKg)} (${ships.length})`])
            : '—'),
        bachesCell,
        cell('Entrega', 'font-mono text-[11px]',
          o.max_delivery_date ? `${fmtDate(o.max_delivery_date)} · ${relDate(o.max_delivery_date)}` : '—'),
        cell('Drying-start', 'font-mono text-[11px]',
          o.latest_drying_start_date
            ? `${fmtDate(o.latest_drying_start_date)} · ${relDate(o.latest_drying_start_date)}`
            : '—'),
        actionsCell,
      ]));
      if (detailRow) tbody.append(detailRow);
  }
  const t = el('table', { class: 'w-full text-[12px] responsive-stack' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', {}, ['Código']),
      el('th', {}, ['Referencia']),
      el('th', {}, ['Cliente']),
      el('th', {}, ['Status']),
      el('th', { class: 'text-right' }, ['Aceptado']),
      el('th', { class: 'text-right' }, ['Asignado']),
      el('th', { class: 'text-right' }, ['Despachado']),
      el('th', { class: 'text-center' }, ['Baches']),
      el('th', {}, ['Entrega']),
      el('th', {}, ['Drying-start']),
      anyActions ? el('th', { class: 'text-right' }, ['Acciones']) : null,
    ])]),
    tbody,
  ]);
  wrap.append(t);
  return wrap;
}

function lotsTable(lots) {
  const wrap = el('div', { class: 'overflow-x-auto ctrm-card' });
  const cell = (label, classes, content) => {
    const td = el('td', { class: classes });
    td.setAttribute('data-label', label);
    if (content instanceof Node) td.append(content);
    else td.append(document.createTextNode(String(content == null ? '—' : content)));
    return td;
  };
  const t = el('table', { class: 'w-full text-[12px] responsive-stack' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', {}, ['Bache']),
      el('th', {}, ['Referencia']),
      el('th', {}, ['Status']),
      el('th', { class: 'text-right' }, ['Cereza']),
      el('th', { class: 'text-right' }, ['Verde esp.']),
      el('th', { class: 'text-right' }, ['Verde real']),
      el('th', {}, ['Listo']),
      el('th', { class: 'text-right' }, ['Asignaciones']),
    ])]),
    el('tbody', {}, lots.map((l) => el('tr', {}, [
      cell('Bache', 'font-mono text-navy font-semibold', l.bache_code || l.lot_code),
      cell('Referencia', '', l.reference_name || '—'),
      cell('Status', '', el('span', { class: `ctrm-pill ${statusPillKind(l.status)}`, text: statusLabel(l.status) })),
      cell('Cereza', 'text-right font-mono', fmtKg(l.kg_cherry_input)),
      cell('Verde esp.', 'text-right font-mono', fmtKg(l.kg_green_expected)),
      cell('Verde real', 'text-right font-mono', l.kg_green_actual != null ? fmtKg(l.kg_green_actual) : '—'),
      cell('Listo', 'font-mono text-[11px]', l.ready_date ? fmtDate(l.ready_date) : '—'),
      cell('Asignaciones', 'text-right font-mono', String((l.assignments || []).length)),
    ]))),
  ]);
  wrap.append(t);
  return wrap;
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

function section(title, children) {
  return el('section', { class: 'mb-6' }, [
    el('h3', { class: 'eyebrow mb-2', text: title }),
    el('div', { class: 'space-y-2' }, children),
  ]);
}

function emptyText(t) {
  return el('p', { class: 'text-[12px] text-ink-300 italic px-1', text: t });
}

export function orderRow(o, opts = {}) {
  const urg = pickUrgency(o);
  const actionButtons = (opts.actions || []).map((a) =>
    el('button', {
      class: `ctrm-btn ctrm-btn-${a.variant === 'danger' ? 'danger' : 'soft'} ctrm-btn-xs`,
      onClick: a.onClick,
    }, [a.label]),
  );

  const rollup = opts.rollup || { ready: 0, drying: 0, fermentation: 0, total: 0, lots: [] };
  const accepted = Number(o.kg_green_accepted ?? o.kg_green_required ?? 0);
  // Mostrar cobertura para pedidos ya aceptados o en producción, incluso
  // cuando no hay ningún lote todavía (asi Forest ve el "0 cubierto").
  const showProgress = accepted > 0
    && ['Accepted', 'PartiallyAccepted', 'InProduction', 'Completed'].includes(o.status);

  // Dropdown expandible con los baches asignados. Sólo se monta si el
  // pedido tiene al menos un lote.
  const assignedLots = rollup.lots || [];
  let lotsWrap = null;
  let lotsToggle = null;
  if (assignedLots.length > 0) {
    lotsWrap = el('div', {
      class: 'mt-2 pt-2 border-t border-sand',
      hidden: 'true',
    }, [assignedLotsDetail(assignedLots)]);
    let expanded = false;
    const collapsedLabel = `▾ ${assignedLots.length} ${assignedLots.length === 1 ? 'bache asignado' : 'baches asignados'}`;
    const expandedLabel  = `▴ Ocultar baches`;
    lotsToggle = el('button', {
      type: 'button',
      class: 'mt-2 text-[11px] font-display uppercase tracking-eyebrow text-ink-500 hover:text-navy inline-flex items-center gap-1',
      style: 'background:none;border:none;padding:4px 0;cursor:pointer;',
      onClick: (e) => {
        e.stopPropagation();
        expanded = !expanded;
        if (expanded) { lotsWrap.removeAttribute('hidden'); lotsToggle.textContent = expandedLabel; }
        else          { lotsWrap.setAttribute('hidden', 'true'); lotsToggle.textContent = collapsedLabel; }
      },
    }, [collapsedLabel]);
  }

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
      showProgress ? meta('Asignado', fmtKg(rollup.total)) : null,
      meta('Cereza', fmtKg(o.kg_cherry_required)),
      meta('Entrega', `${fmtDate(o.max_delivery_date)} (${relDate(o.max_delivery_date)})`),
      meta('Drying-start', fmtDate(o.latest_drying_start_date)),
      meta('Proceso', o.process_type),
    ]),
    showProgress ? coverageBar(rollup, accepted) : null,
    (opts.shipments && opts.shipments.length > 0)
      ? shippedChips(opts.shipments)
      : null,
    lotsToggle,
    lotsWrap,
    actionButtons.length > 0
      ? el('div', { class: 'flex gap-2 mt-3 pt-2 border-t border-sand' }, actionButtons)
      : null,
  ]);
}

// Lista compacta de baches asignados al pedido. Se renderiza como
// tabla con el mismo design system que las demás (thead eyebrow,
// border-t sand entre rows). Una fila por bache con: Bache (código +
// status pill), Despacho (chips si aplica), Factor, Proceso, Café
// seco, Variedades y kg verde asignado al pedido.
function assignedLotsDetail(lots) {
  const total = lots.reduce((s, l) => s + Number(l.kg || 0), 0);
  const tcell = (label, classes, content) => {
    const td = el('td', { class: `px-2 py-1.5 ${classes || ''}` });
    td.setAttribute('data-label', label);
    if (content instanceof Node) td.append(content);
    else td.append(document.createTextNode(String(content == null ? '—' : content)));
    return td;
  };

  const sorted = lots
    .slice()
    .sort((a, b) => (a.bache_code || a.lot_code || '').localeCompare(b.bache_code || b.lot_code || ''));

  const rows = sorted.map((l) => {
    const ships = (l.shipments || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const shipNode = ships.length === 0
      ? document.createTextNode('—')
      : el('div', { class: 'flex flex-wrap gap-1' }, ships.map((s) =>
          el('span', {
            class: 'ctrm-code text-[10px]',
            title: `${s.code} · ${fmtDate(s.date)}`,
            style: 'border-color:#3a6f4a;color:#3a6f4a;',
          }, [s.code])));
    const bacheNode = el('div', { class: 'flex items-center gap-1 flex-wrap' }, [
      el('span', { class: 'ctrm-code text-[10px]', text: l.bache_code || l.lot_code }),
      el('span', { class: `ctrm-pill text-[10px] ${statusPillKind(l.status)}`, text: statusLabel(l.status) }),
    ]);
    return el('tr', {
      class: 'border-t border-sand hover:bg-sand cursor-pointer',
      onClick: () => { location.hash = '/finca/lots'; },
      title: `Ir a Producción · ${l.bache_code || l.lot_code}`,
    }, [
      tcell('Bache', '', bacheNode),
      tcell('Despacho', '', shipNode),
      tcell('Factor', 'text-right font-mono', l.factor_rendimiento != null ? String(l.factor_rendimiento) : '—'),
      tcell('Proceso', 'text-[10px]', l.process_type || '—'),
      tcell('Café seco', 'text-right font-mono', l.kg_dried_output != null ? fmtKg(l.kg_dried_output) : '—'),
      tcell('Variedades', 'text-[10px] text-ink-700', (l.varieties || []).join(', ') || '—'),
      tcell('kg verde', 'text-right font-mono font-semibold text-ink-700', fmtKg(l.kg)),
    ]);
  });

  return el('div', {}, [
    el('div', { class: 'flex items-baseline justify-between flex-wrap gap-2 mb-2' }, [
      el('span', { class: 'eyebrow text-[10px]', text: 'Baches asignados' }),
      el('span', { class: 'text-[11px] font-mono text-ink-500' }, [
        el('strong', { class: 'text-navy', text: fmtKg(total) }),
        ` · ${lots.length} ${lots.length === 1 ? 'bache' : 'baches'}`,
      ]),
    ]),
    el('div', { class: 'overflow-x-auto bg-white rounded-md border border-sand' }, [
      el('table', { class: 'w-full text-[11px] responsive-stack' }, [
        el('thead', {}, [el('tr', { class: 'text-ink-300 uppercase tracking-loose' }, [
          el('th', { class: 'text-left px-2 py-1.5 font-display text-[10px] tracking-eyebrow' }, ['Bache']),
          el('th', { class: 'text-left px-2 py-1.5 font-display text-[10px] tracking-eyebrow' }, ['Despacho']),
          el('th', { class: 'text-right px-2 py-1.5 font-display text-[10px] tracking-eyebrow' }, ['Factor']),
          el('th', { class: 'text-left px-2 py-1.5 font-display text-[10px] tracking-eyebrow' }, ['Proceso']),
          el('th', { class: 'text-right px-2 py-1.5 font-display text-[10px] tracking-eyebrow' }, ['Café seco']),
          el('th', { class: 'text-left px-2 py-1.5 font-display text-[10px] tracking-eyebrow' }, ['Variedades']),
          el('th', { class: 'text-right px-2 py-1.5 font-display text-[10px] tracking-eyebrow' }, ['kg verde']),
        ])]),
        el('tbody', {}, rows),
      ]),
    ]),
  ]);
}

function shippedChips(shipments) {
  const sorted = shipments.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const total = sorted.reduce((s, x) => s + Number(x.kg || 0), 0);
  return el('div', { class: 'mt-2 pt-2 border-t border-sand' }, [
    el('div', { class: 'flex items-baseline justify-between flex-wrap gap-2 mb-1' }, [
      el('span', { class: 'eyebrow text-[10px]', text: 'Despachado' }),
      el('span', { class: 'text-[11px] font-mono text-ink-500' }, [
        el('strong', { class: 'text-forest-dark', text: fmtKg(total) }),
        ` · ${sorted.length} despacho${sorted.length === 1 ? '' : 's'}`,
      ]),
    ]),
    el('div', { class: 'flex flex-wrap gap-1' }, sorted.map((s) =>
      el('span', {
        class: 'ctrm-code text-[10px]',
        title: `${s.code} · ${fmtDate(s.date)} · ${fmtKg(s.kg)} verde`,
        style: 'border-color:#3a6f4a;color:#3a6f4a;',
      }, [`${s.code} · ${fmtKg(s.kg)}`]))),
  ]);
}

// Visual breakdown of how much of the order is covered by lots, split by
// lot stage. Order status "InProduction" with rollup.ready > 0 means the
// finca already has finished bache(s) waiting for shipment.
function coverageBar(rollup, accepted) {
  const delivered = Number(rollup.delivered || 0);
  const ready = Number(rollup.ready || 0);
  const drying = Number(rollup.drying || 0);
  const ferm = Number(rollup.fermentation || 0);
  const total = Number(rollup.total || 0);
  const pct = (kg) => Math.max(0, Math.min(100, (kg / accepted) * 100));
  const pending = Math.max(0, accepted - total);
  const noLotsYet = total <= 0.001;

  const segs = [
    { kg: delivered, color: '#3a6f4a', label: 'Entregado' },
    { kg: ready,     color: '#5d8b66', label: 'Ready' },
    { kg: drying,    color: '#ddae3e', label: 'Drying' },
    { kg: ferm,      color: '#7e9ec1', label: 'Fermentación' },
  ].filter((s) => s.kg > 0);

  const lotChips = (rollup.lots || [])
    .slice()
    .sort((a, b) => stageOrder(a.status) - stageOrder(b.status))
    .map((l) => el('span', {
      class: `ctrm-code text-[10px]`,
      title: `${l.code} · ${statusLabel(l.status)} · ${fmtKg(l.kg)} verde`,
      style: `border-color:${stageColor(l.status)};color:${stageColor(l.status)};`,
    }, [`${l.code} · ${fmtKg(l.kg)}`]));

  let summaryRight;
  if (noLotsYet) {
    summaryRight = el('span', { class: 'text-[11px] font-mono text-warn' },
      [`Sin lotes asignados · ${fmtKg(accepted)} pendiente`]);
  } else {
    summaryRight = el('span', { class: 'text-[11px] font-mono text-ink-500' }, [
      el('strong', { class: 'text-ink-700', text: `${fmtKg(total)}` }),
      ` / ${fmtKg(accepted)} verde`,
      total > accepted + 0.001
        ? el('span', { class: 'text-roll', text: ` · Excedente +${fmtKg(total - accepted)}` })
        : pending > 0.001
          ? el('span', { class: 'text-warn', text: ` · ${fmtKg(pending)} sin asignar` })
          : el('span', { class: 'text-ok', text: ' · cubierto' }),
    ]);
  }

  return el('div', { class: 'mt-2 pt-2 border-t border-sand space-y-1' }, [
    el('div', { class: 'flex items-center justify-between gap-2 flex-wrap' }, [
      el('span', { class: 'eyebrow text-[10px]', text: 'Cobertura por lotes' }),
      summaryRight,
    ]),
    el('div', { class: 'flex h-2 rounded-full overflow-hidden bg-sand' },
      segs.length > 0
        ? segs.map((s) => el('div', {
            class: 'h-full',
            style: `width:${pct(s.kg)}%;background:${s.color};`,
            title: `${s.label}: ${fmtKg(s.kg)}`,
          }))
        : []),
    lotChips.length > 0
      ? el('div', { class: 'flex flex-wrap gap-1' }, lotChips)
      : null,
  ]);
}

function stageOrder(status) {
  return { Delivered: -1, Ready: 0, Drying: 1, InFermentation: 2 }[status] ?? 99;
}

function stageColor(status) {
  return {
    Delivered: '#3a6f4a',
    Ready: '#5d8b66',
    Drying: '#ddae3e',
    InFermentation: '#7e9ec1',
  }[status] || '#9aa3ae';
}

function lotRow(l) {
  return el('div', { class: 'ctrm-card ctrm-card-pad' }, [
    el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-2' }, [
      el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
        el('span', { class: 'ctrm-code', text: l.lot_code }),
        el('span', { class: 'font-display font-semibold text-navy text-[13px]', text: l.reference_name || '—' }),
        el('span', { class: `ctrm-pill ${statusPillKind(l.status)}`, text: statusLabel(l.status) }),
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
  const u = o.delivery_urgency === 'past' || o.delivery_urgency === 'red'
    ? o.delivery_urgency
    : o.drying_urgency;
  if (!u || u === 'normal') return null;
  return { kind: u, label: URGENCY_LABEL[u] || u };
}

// ────────────────────────────────────────────────────────────────────
// Edit pending pedido — modal with the same fields as the demand form
// ────────────────────────────────────────────────────────────────────
function openOrderEditModal(order, allReferences, allVarieties) {
  return openModal(({ close }) => {
    let selectedRef = allReferences.find((r) => r.id === order.reference_id) || null;
    const initialVarieties = (order.varieties || []).map((v) => v);
    let selectedVarieties = [...initialVarieties];

    const refCombo = createCombobox({
      placeholder: 'Buscar referencia...',
      items: allReferences,
      value: selectedRef,
      onChange: (item) => {
        selectedRef = item;
        if (item?.process_type) processSelect.value = item.process_type;
        if (item?.fermentation_hours != null && fermInput.value === '') {
          fermInput.value = String(item.fermentation_hours);
        }
      },
    });

    const varietyCombo = createMultiCombobox({
      placeholder: 'Variedades...',
      items: allVarieties,
      values: selectedVarieties,
      onChange: (v) => { selectedVarieties = v; },
    });

    const kgInput = el('input', {
      type: 'number', min: '0', step: '0.01', required: true,
      value: String(order.kg_green_required || ''),
      class: 'ctrm-input mono',
    });
    const dateInput = el('input', {
      type: 'date', required: true,
      value: order.max_delivery_date || '',
      class: 'ctrm-input',
    });
    const aspectSelect = el('select', { class: 'ctrm-select', required: true }, [
      el('option', { value: '', disabled: true }, ['Selecciona aspecto...']),
      ...PHYSICAL_ASPECTS.map((a) => el('option', { value: a, selected: order.physical_aspect === a }, [a])),
    ]);
    const processSelect = el('select', { class: 'ctrm-select', required: true }, [
      el('option', { value: '', disabled: true }, ['Selecciona proceso...']),
      ...PROCESS_TYPES.map((p) => el('option', { value: p, selected: order.process_type === p }, [p])),
    ]);
    const fermInput = el('input', {
      type: 'number', min: '0', step: '0.5', placeholder: 'Opcional',
      value: order.fermentation_hours != null ? String(order.fermentation_hours) : '',
      class: 'ctrm-input mono',
    });

    const orderTypeSelect = el('select', { class: 'ctrm-select' }, [
      el('option', { value: '' }, ['—']),
      ...ORDER_TYPES.map((t) => el('option', { value: t, selected: order.order_type === t }, [t])),
    ]);
    const clientInput = el('input', {
      type: 'text', placeholder: 'Cliente',
      value: order.client_name || '',
      class: 'ctrm-input',
    });
    const contractInput = el('input', {
      type: 'text', placeholder: 'Código',
      value: order.contract_code || '',
      class: 'ctrm-input mono',
    });
    const intensitySelect = el('select', { class: 'ctrm-select' }, [
      el('option', { value: '' }, ['Sin especificar']),
      el('option', { value: 'media',    selected: order.intensity === 'media' }, ['Media']),
      el('option', { value: 'alta',     selected: order.intensity === 'alta' }, ['Alta']),
      el('option', { value: 'muy_alta', selected: order.intensity === 'muy_alta' }, ['Muy alta']),
    ]);
    const orderRegions = order.regions || [];
    const regionInputs = REGIONS.map((r) => {
      const cb = el('input', {
        type: 'checkbox', value: r,
        checked: orderRegions.includes(r),
        class: 'h-4 w-4 accent-navy mr-1.5',
      });
      return { region: r, input: cb, node: el('label', {
        class: 'inline-flex items-center px-2 py-1 rounded-md border border-sand bg-white text-[12px] font-medium text-ink-700 cursor-pointer hover:border-navy',
      }, [cb, r]) };
    });
    const regionsRow = el('div', { class: 'flex flex-wrap gap-2' }, regionInputs.map((r) => r.node));

    const commentsInput = el('textarea', {
      rows: '3', placeholder: 'Comentarios',
      class: 'ctrm-textarea',
      value: order.comments || '',
    });

    return el('div', { class: 'space-y-3' }, [
      labelled('Referencia', refCombo.el),
      labelled('Variedades', varietyCombo.el),
      labelled('kg verde requeridos', kgInput),
      labelled('Fecha máxima de entrega', dateInput),
      labelled('Aspecto físico', aspectSelect),
      labelled('Proceso', processSelect),
      labelled('Horas de fermentación', fermInput),
      el('div', { class: 'pt-3 border-t border-sand' }, [
        el('p', { class: 'eyebrow mb-3', text: 'Metadatos comerciales' }),
        el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-3' }, [
          labelled('Tipo', orderTypeSelect),
          labelled('Cliente', clientInput),
        ]),
        el('div', { class: 'mt-3' }, [labelled('Región', regionsRow)]),
        el('div', { class: 'mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3' }, [
          labelled('Código de contrato', contractInput),
          labelled('Intensidad', intensitySelect),
        ]),
      ]),
      labelled('Comentarios', commentsInput),
      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-primary',
          type: 'button',
          onClick: () => {
            if (!selectedRef) { toast('Selecciona referencia', 'warning'); return; }
            const kg = Number(kgInput.value);
            if (!(kg > 0)) { toast('kg inválido', 'warning'); return; }
            if (!dateInput.value) { toast('Falta fecha', 'warning'); return; }
            if (!aspectSelect.value) { toast('Falta aspecto', 'warning'); return; }
            if (!processSelect.value) { toast('Falta proceso', 'warning'); return; }
            const selectedRegions = regionInputs.filter((r) => r.input.checked).map((r) => r.region);
            close({
              fields: {
                reference_id: selectedRef.id,
                variety_ids: selectedVarieties.map((v) => v.id),
                kg_green_required: kg,
                max_delivery_date: dateInput.value,
                physical_aspect: aspectSelect.value,
                process_type: processSelect.value,
                fermentation_hours: fermInput.value === '' ? null : Number(fermInput.value),
                order_type: orderTypeSelect.value || null,
                client_name: clientInput.value.trim() || null,
                regions: selectedRegions.length > 0 ? selectedRegions : null,
                contract_code: contractInput.value.trim() || null,
                intensity: intensitySelect.value || null,
                comments: commentsInput.value || null,
              },
            });
          },
        }, ['Guardar cambios']),
      ]),
    ]);
  }, { title: `Editar ${order.order_code}`, wide: true });
}

// ────────────────────────────────────────────────────────────────────
// Cancel pending pedido — small modal with optional reason
// ────────────────────────────────────────────────────────────────────
function openCancelModal(order) {
  return openModal(({ close }) => {
    const reasonInput = el('textarea', {
      rows: '3', placeholder: 'Motivo (opcional)',
      class: 'ctrm-textarea',
    });
    return el('div', { class: 'space-y-3' }, [
      el('div', { class: 'rounded-lg bg-cream border border-sand p-3 text-[12px] space-y-1' }, [
        el('div', {}, [`Pedido: `, el('strong', { text: order.order_code })]),
        el('div', {}, [`Referencia: `, el('strong', { text: order.reference_name || '—' })]),
        el('div', {}, [`kg verde: `, el('strong', { text: fmtKg(order.kg_green_required) })]),
      ]),
      el('label', { class: 'ctrm-label', text: 'Motivo' }),
      reasonInput,
      el('p', { class: 'ctrm-hint', text: 'El motivo se guarda en los comentarios del pedido.' }),
      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Volver']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-danger',
          type: 'button',
          onClick: () => close({ reason: reasonInput.value.trim() }),
        }, ['Cancelar pedido']),
      ]),
    ]);
  }, { title: `Cancelar ${order.order_code}` });
}

function labelled(label, child) {
  return el('div', {}, [
    el('label', { class: 'ctrm-label', text: label }),
    child,
  ]);
}

// ─── Seguimiento: tabla y card ──────────────────────────────────────
function seguimientoTable(rows, rollupMap, shipmentsMap, expandedSet, onToggle) {
  const wrap = el('div', { class: 'overflow-x-auto ctrm-card' });
  const cell = (label, classes, content) => {
    const td = el('td', { class: classes });
    td.setAttribute('data-label', label);
    if (content instanceof Node) td.append(content);
    else td.append(document.createTextNode(String(content == null ? '—' : content)));
    return td;
  };

  const tbody = el('tbody', {});
  for (const r of rows) {
    const { o, aceptado, enProceso, listo, despachado, saldo, isClosed } = r;
    const saldoCls = saldo > 0.001
      ? 'text-right font-mono text-warn'
      : saldo < -0.001
        ? 'text-right font-mono text-roll'
        : 'text-right font-mono text-ok';
    const saldoLabel = saldo > 0.001
      ? fmtKg(saldo)
      : saldo < -0.001 ? `+${fmtKg(-saldo)}` : 'Cerrado';
    const isExp = expandedSet.has(o.id);
    const lotsCount = ((rollupMap.get(o.id) || {}).lots || []).length;
    const shipsCount = (shipmentsMap.get(o.id) || []).length;

    const actionBtn = el('button', {
      type: 'button',
      class: 'ctrm-btn ctrm-btn-soft ctrm-btn-xs',
      onClick: (e) => { e.stopPropagation(); onToggle(o.id); },
    }, [isExp ? '▾ Ocultar' : `▸ Ver lotes (${lotsCount + shipsCount})`]);

    tbody.append(el('tr', {
      class: `${isClosed ? 'text-ink-500' : ''}`,
    }, [
      cell('Código', 'font-mono text-navy font-semibold', o.order_code),
      cell('Referencia', '', o.reference_name || '—'),
      cell('Cliente', '', o.client_name || '—'),
      cell('Status', '', el('span', { class: `ctrm-pill ${statusPillKind(o.status)}`, text: statusLabel(o.status) })),
      cell('Aceptado',  'text-right font-mono', fmtKg(aceptado)),
      cell('En proceso','text-right font-mono', enProceso > 0 ? fmtKg(enProceso) : '—'),
      cell('Listo',     'text-right font-mono', listo > 0 ? fmtKg(listo) : '—'),
      cell('Despachado','text-right font-mono',
        despachado > 0 ? el('span', { style: 'color:#3a6f4a;font-weight:600;' }, [fmtKg(despachado)]) : '—'),
      cell('Saldo', saldoCls, saldoLabel),
      cell('Entrega', 'font-mono text-[11px]',
        o.max_delivery_date ? `${fmtDate(o.max_delivery_date)} · ${relDate(o.max_delivery_date)}` : '—'),
      cell('', 'text-right', actionBtn),
    ]));

    if (isExp) {
      const expandRow = el('tr', { class: 'bg-cream' }, [
        el('td', { colspan: '11', class: 'p-3' }, [
          renderLotsBreakdown(o, rollupMap, shipmentsMap),
        ]),
      ]);
      tbody.append(expandRow);
    }
  }

  const t = el('table', { class: 'w-full text-[12px] responsive-stack' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', {}, ['Código']),
      el('th', {}, ['Referencia']),
      el('th', {}, ['Cliente']),
      el('th', {}, ['Status']),
      el('th', { class: 'text-right' }, ['Aceptado']),
      el('th', { class: 'text-right' }, ['En proceso']),
      el('th', { class: 'text-right' }, ['Listo']),
      el('th', { class: 'text-right' }, ['Despachado']),
      el('th', { class: 'text-right' }, ['Saldo']),
      el('th', {}, ['Entrega']),
      el('th', { class: 'text-right' }, ['Lotes']),
    ])]),
    tbody,
  ]);
  wrap.append(t);
  return wrap;
}

function seguimientoCard(r, rollupMap, shipmentsMap, expandedSet, onToggle) {
  const { o, aceptado, enProceso, listo, despachado, saldo, isClosed } = r;
  const isExp = expandedSet.has(o.id);
  const lotsCount = ((rollupMap.get(o.id) || {}).lots || []).length;
  const shipsCount = (shipmentsMap.get(o.id) || []).length;
  const saldoChip = saldo > 0.001
    ? el('span', { class: 'ctrm-pill warn', text: `Saldo ${fmtKg(saldo)}` })
    : saldo < -0.001
      ? el('span', { class: 'ctrm-pill roll', text: `Excedente +${fmtKg(-saldo)}` })
      : el('span', { class: 'ctrm-pill ok', text: 'Cerrado' });

  return el('div', { class: `ctrm-card ${isClosed ? 'opacity-70' : ''}` }, [
    el('div', { class: 'ctrm-card-pad' }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-2' }, [
        el('div', { class: 'flex items-center gap-2 flex-wrap min-w-0' }, [
          el('span', { class: 'ctrm-code', text: o.order_code }),
          el('span', { class: 'font-display font-semibold text-navy text-[13px] truncate', text: o.reference_name || '—' }),
          el('span', { class: `ctrm-pill ${statusPillKind(o.status)}`, text: statusLabel(o.status) }),
        ]),
        saldoChip,
      ]),
      el('div', { class: 'grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-mono mb-1' }, [
        kpiBlock('Aceptado',  fmtKg(aceptado)),
        kpiBlock('En proceso', enProceso > 0 ? fmtKg(enProceso) : '—'),
        kpiBlock('Listo',      listo > 0 ? fmtKg(listo) : '—'),
        kpiBlock('Despachado', despachado > 0 ? fmtKg(despachado) : '—', '#3a6f4a'),
      ]),
      o.client_name || (o.regions && o.regions.length)
        ? el('div', { class: 'text-[11px] text-ink-500 mt-1' }, [
            o.client_name ? `Cliente: ${o.client_name}` : null,
            o.regions && o.regions.length ? ` · Regiones: ${o.regions.join(', ')}` : null,
            o.max_delivery_date ? ` · Entrega: ${fmtDate(o.max_delivery_date)} (${relDate(o.max_delivery_date)})` : null,
          ])
        : null,
    ]),
    // Footer expand button (full-width)
    el('button', {
      type: 'button',
      class: 'w-full px-4 py-2.5 border-t border-sand bg-cream hover:bg-sand text-[12px] font-display font-semibold text-navy uppercase tracking-eyebrow flex items-center justify-center gap-2',
      onClick: () => onToggle(o.id),
    }, [
      el('span', { text: isExp ? '▾' : '▸' }),
      el('span', { text: isExp ? 'Ocultar lotes' : `Ver lotes asignados (${lotsCount})${shipsCount > 0 ? ` + ${shipsCount} despacho${shipsCount === 1 ? '' : 's'}` : ''}` }),
    ]),
    isExp ? el('div', { class: 'p-3 border-t border-sand bg-cream' }, [
      renderLotsBreakdown(o, rollupMap, shipmentsMap),
    ]) : null,
  ]);
}

// Desglose de lotes asignados a un pedido + despachos. Renderiza
// dos tablas (Lotes / Despachos) por filas con bullet de color por
// status. Más comprensivo que chips para auditar el flujo del pedido.
const STAGE_LABELS = {
  InFermentation: 'Fermentación',
  Drying: 'Drying',
  Ready: 'Listo',
  Delivered: 'Despachado',
};
const STAGE_COLORS = {
  InFermentation: '#7e9ec1',
  Drying:         '#ddae3e',
  Ready:          '#5d8b66',
  Delivered:      '#3a6f4a',
};
const STAGE_ORDER = { InFermentation: 1, Drying: 2, Ready: 3, Delivered: 4 };

function renderLotsBreakdown(order, rollupMap, shipmentsMap) {
  const rollup = rollupMap.get(order.id);
  const lots = (rollup && rollup.lots) || [];
  const ships = shipmentsMap.get(order.id) || [];

  if (lots.length === 0 && ships.length === 0) {
    return el('p', { class: 'text-[11px] text-ink-500 italic', text: 'Este pedido aún no tiene lotes asignados.' });
  }

  const sortedLots = lots.slice().sort((a, b) =>
    (STAGE_ORDER[a.status] || 99) - (STAGE_ORDER[b.status] || 99));

  return el('div', { class: 'space-y-3' }, [
    lots.length > 0 ? el('div', {}, [
      el('p', { class: 'eyebrow text-[10px] mb-1', text: `Lotes asignados (${lots.length})` }),
      lotsBreakdownTable(sortedLots),
    ]) : null,
    ships.length > 0 ? el('div', {}, [
      el('p', { class: 'eyebrow text-[10px] mb-1', text: `Despachos (${ships.length})` }),
      shipsBreakdownTable(ships),
    ]) : null,
  ]);
}

function lotsBreakdownTable(lots) {
  return el('div', { class: 'overflow-x-auto bg-white rounded-md border border-sand' }, [
    el('table', { class: 'w-full text-[11px]' }, [
      el('thead', {}, [el('tr', { class: 'text-ink-300 uppercase tracking-loose' }, [
        el('th', { class: 'text-left px-3 py-1.5' }, ['Bache']),
        el('th', { class: 'text-left px-3 py-1.5' }, ['Status']),
        el('th', { class: 'text-right px-3 py-1.5' }, ['kg verde']),
      ])]),
      el('tbody', {}, lots.map((l) => {
        const color = STAGE_COLORS[l.status] || '#9aa3ae';
        return el('tr', { class: 'border-t border-sand' }, [
          el('td', { class: 'px-3 py-1.5 font-mono font-semibold' }, [
            el('span', {
              class: 'inline-block w-1.5 h-1.5 rounded-full mr-2 align-middle',
              style: `background:${color};`,
            }),
            l.code,
          ]),
          el('td', { class: 'px-3 py-1.5', style: `color:${color};font-weight:600;`,
            text: STAGE_LABELS[l.status] || l.status }),
          el('td', { class: 'px-3 py-1.5 text-right font-mono text-ink-700', text: fmtKg(l.kg) }),
        ]);
      })),
    ]),
  ]);
}

function shipsBreakdownTable(ships) {
  const sorted = ships.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return el('div', { class: 'overflow-x-auto bg-white rounded-md border border-sand' }, [
    el('table', { class: 'w-full text-[11px]' }, [
      el('thead', {}, [el('tr', { class: 'text-ink-300 uppercase tracking-loose' }, [
        el('th', { class: 'text-left px-3 py-1.5' }, ['Despacho']),
        el('th', { class: 'text-left px-3 py-1.5' }, ['Fecha']),
        el('th', { class: 'text-right px-3 py-1.5' }, ['kg verde']),
      ])]),
      el('tbody', {}, sorted.map((s) => el('tr', { class: 'border-t border-sand' }, [
        el('td', { class: 'px-3 py-1.5 font-mono font-semibold', style: 'color:#3a6f4a;',
          text: s.code }),
        el('td', { class: 'px-3 py-1.5 font-mono', text: fmtDate(s.date) }),
        el('td', { class: 'px-3 py-1.5 text-right font-mono text-ink-700', text: fmtKg(s.kg) }),
      ]))),
    ]),
  ]);
}

function kpiBlock(label, value, color) {
  return el('div', {
    class: 'rounded-md border border-sand p-2',
  }, [
    el('p', { class: 'text-ink-300 uppercase tracking-loose text-[9px] mb-0.5', text: label }),
    el('p', { class: 'font-display font-semibold text-navy text-[13px]',
      style: color ? `color:${color};` : null, text: value }),
  ]);
}
