// Cola de pedidos para finca — vista cronológica + mini-timeline por
// pedido mostrando "hoy", "drying-start max" y "entrega".
//
// El timeline es indicativo: ayuda a decidir cual procesar primero.
// Se ordena por latest_drying_start_date asc (los mas urgentes arriba)
// y muestra coverage por lotes para que se vea de un vistazo cuanto
// kg verde ya esta en producción y cuanto falta.

import { el } from '../ui/el.js';
import { fmtKg, fmtDate, fmtIntensity, statusLabel, statusPillKind, relDate } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { navigate } from '../router.js';
import { sortableTable } from '../ui/sortable-table.js';
import { emptyStateCard } from '../ui/empty.js';
import { renderFilterButton } from '../ui/filters-sheet.js';
import { createViewMode } from '../ui/view-mode.js';
import { openPopover } from '../ui/popover.js';
import { openModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { renderOrderCard } from './_order-card.js';

const FILTERS = [
  { key: 'all',         label: 'Todos' },
  { key: 'no-lot',      label: 'Sin lote' },
  { key: 'partial-lot', label: 'Cobertura parcial' },
  { key: 'overdue',     label: 'Vencidos' },
];

export async function fincaColaView() {
  const [ordersRes, lotsRes, shipsRes] = await Promise.all([
    api.ordersList({}),
    api.lotsList({}),   // todos: incluye Delivered para allocByOrder correcto
    api.shipmentsList().catch(() => ({ shipments: [] })),
  ]);
  const today      = ordersRes.today;
  const allOrders  = ordersRes.orders || [];
  const allLots    = lotsRes.lots || [];
  const shipments  = (shipsRes && shipsRes.shipments) || [];
  // Solo los lotes activos se usan para timeline / capacity overlay,
  // pero allocByOrder cuenta TODOS (incluyendo Delivered).
  const activeLots = allLots.filter((l) => l.status !== 'Delivered');

  // Capacidad semanal calculada via /api/capacity-calculate sobre los
  // pedidos in-flight. Sirve para marcar la semana de cada pedido
  // como sobrecargada (rojo) o disponible (verde).
  const inFlightIds = allOrders
    .filter((o) => ['Accepted', 'PartiallyAccepted', 'InProduction'].includes(o.status))
    .map((o) => o.id);
  let capacity = null;
  if (inFlightIds.length > 0) {
    try {
      capacity = await api.capacity({ order_ids: inFlightIds, include_active_queue: true });
    } catch { /* silent fallback: no capacity overlay */ }
  }
  const weeklyByKey = new Map();
  for (const w of (capacity?.weekly_load || [])) weeklyByKey.set(w.iso_week_key, w);
  const cherryCap = capacity?.weekly_cherry_capacity_kg || 60000;

  // Coverage por pedido: suma de kg verde asignado desde TODOS los
  // lotes, incluyendo Delivered. Sin esto un pedido cuyo aceptado ya
  // fue cubierto en parte por un lote entregado aparece como
  // "pendiente" la diferencia, induciendo a sobre-asignar.
  const allocByOrder = new Map();
  const infusionsByOrder = new Map();   // order_id → Set<infusion_name>
  // Baches asignados a cada pedido con kg específico y despachos
  // (para el dropdown de la vista Tabla).
  //   lotsByOrder: order_id → [{ lot, kg_green_allocated, shipments[] }]
  //   shipments[] = pills clickeables { shipment_id, shipment_code, shipment_date, kg }
  const lotsByOrder = new Map();
  for (const lot of allLots) {
    for (const a of lot.assignments || []) {
      const oid = a.demand_order_id;
      allocByOrder.set(oid,
        (allocByOrder.get(oid) || 0) + Number(a.kg_green_allocated || 0));
      if (lot.infusion_name) {
        if (!infusionsByOrder.has(oid)) infusionsByOrder.set(oid, new Set());
        infusionsByOrder.get(oid).add(lot.infusion_name);
      }
      // Buscar despachos que llevaron ESTE bache específicamente al
      // pedido oid (kg del despacho pueden ser < kg total del lote
      // si es despacho parcial).
      const shipmentPills = [];
      for (const s of shipments) {
        for (const sl of s.lots || []) {
          if (sl.id !== lot.id) continue;
          for (const sa of sl.assignments || []) {
            const soid = sa.order ? sa.order.id : null;
            if (soid !== oid) continue;
            shipmentPills.push({
              shipment_id: s.id,
              shipment_code: s.shipment_code,
              shipment_date: s.shipment_date,
              kg: Number(sa.kg_green_allocated || 0),
            });
          }
        }
      }
      if (!lotsByOrder.has(oid)) lotsByOrder.set(oid, []);
      lotsByOrder.get(oid).push({
        lot,
        kg_green_allocated: Number(a.kg_green_allocated || 0),
        shipments: shipmentPills,
      });
    }
  }

  // Despachado por pedido: suma de kg verde asignado en cada shipment.
  const shippedByOrder = new Map();
  for (const s of shipments) {
    for (const l of s.lots || []) {
      for (const a of l.assignments || []) {
        const oid = a.order ? a.order.id : a.demand_order_id;
        if (!oid) continue;
        shippedByOrder.set(oid,
          (shippedByOrder.get(oid) || 0) + Number(a.kg_green_allocated || 0));
      }
    }
  }

  const inFlight = allOrders
    .filter((o) => ['Accepted', 'PartiallyAccepted', 'InProduction'].includes(o.status))
    .map((o) => {
      const accepted  = Number(o.kg_green_accepted || 0);
      const allocated = allocByOrder.get(o.id) || 0;
      const pending   = Math.max(0, accepted - allocated);
      const wkey = o.iso_week_key || null;
      const weekBucket = wkey ? weeklyByKey.get(wkey) : null;
      const infNames = [...(infusionsByOrder.get(o.id) || [])];
      const shipped = shippedByOrder.get(o.id) || 0;
      return { ...o, allocated_kg: allocated, pending_kg: pending, shipped_kg: shipped, week_bucket: weekBucket, infusion_names: infNames };
    })
    .sort((a, b) => (a.latest_drying_start_date || '').localeCompare(b.latest_drying_start_date || ''));

  // Historial: pedidos terminados (Completed) y cancelados. Se ven
  // en el tab "Terminados" con sus baches asignados para verificar
  // lo que ya pasó.
  const finished = allOrders
    .filter((o) => ['Completed', 'Cancelled'].includes(o.status))
    .map((o) => ({
      ...o,
      allocated_kg: allocByOrder.get(o.id) || 0,
      shipped_kg: shippedByOrder.get(o.id) || 0,
      closed_at: (o.completed_at || o.cancelled_at || '').slice(0, 10) || null,
    }))
    .sort((a, b) => (b.closed_at || '').localeCompare(a.closed_at || ''));

  // Escala global para el timeline (today → maxDelivery)
  const earliest = today;
  const latest = inFlight.reduce(
    (max, o) => (o.max_delivery_date || '') > max ? o.max_delivery_date : max,
    today,
  );

  let currentFilter = 'all';
  let sheetValues = {};   // { client_name?: [...], process_type?: [...] }
  // Pedidos expandidos en la vista Tabla (dropdown con lotes asignados).
  const expandedOrders = new Set();
  const expandedFinished = new Set();
  let activeTab = 'en_curso';   // 'en_curso' | 'terminados'

  // ── Cancelar pedido (con motivo, auditado) ─────────────────────
  async function cancelOrderModal(o) {
    const reasonInput = el('textarea', {
      rows: '3', class: 'ctrm-textarea w-full',
      placeholder: 'Motivo de la cancelación…',
    });
    const out = await openModal(({ close }) => el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-[12px] text-ink-700 leading-relaxed' }, [
        `Cancelar el pedido `,
        el('strong', { class: 'text-navy', text: o.order_code || o.id.slice(0, 8) }),
        o.client_name ? ` de ${o.client_name}` : '',
        `. El pedido pasa a Cancelado y queda en el historial de Terminados. `,
        `Si tiene baches asignados sin despachar, primero hay que quitar esas asignaciones desde Producción.`,
      ]),
      el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'Motivo *' }),
        reasonInput,
      ]),
      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { type: 'button', class: 'ctrm-btn ctrm-btn-ghost', onClick: () => close(null) }, ['Volver']),
        el('button', {
          type: 'button', class: 'ctrm-btn ctrm-btn-danger',
          onClick: () => {
            const reason = reasonInput.value.trim();
            if (!reason) { toast('Indica el motivo de la cancelación', 'warning'); return; }
            close({ reason });
          },
        }, ['Cancelar pedido']),
      ]),
    ]), { title: 'Cancelar pedido' });

    if (!out) return;
    try {
      await api.orderCancel({ order_id: o.id, reason: out.reason });
      toast(`Pedido ${o.order_code || ''} cancelado`, 'success');
      navigate('/finca/cola');
    } catch (e) {
      if (e.code === 'HAS_LOT_ASSIGNMENTS') {
        const baches = ((e.detail && e.detail.assignments) || [])
          .map((a) => a.bache_code).filter(Boolean).join(', ');
        toast(
          `No se puede cancelar: tiene asignaciones activas${baches ? ` (${baches})` : ''}. Quítalas desde Producción primero.`,
          'error', 8000,
        );
      } else {
        toast(e.message || 'Error al cancelar', 'error', 6000);
      }
    }
  }

  // Filtros del sheet: cliente + proceso. Las opciones se derivan de
  // los pedidos in-flight cargados.
  const sheetFilters = [
    { key: 'client_name', label: 'Cliente', multi: true,
      options: [...new Set(inFlight.map((o) => o.client_name).filter(Boolean))].sort(),
      getter: (o) => o.client_name || '' },
    { key: 'process_type', label: 'Proceso', multi: true,
      options: ['Natural', 'Honey', 'Lavado'],
      getter: (o) => o.process_type || '' },
    { key: 'infusion', label: 'Infusión', multi: true,
      options: [...new Set(allLots.map((l) => l.infusion_name).filter(Boolean))].sort(),
      // Match: el pedido tiene al menos un lote con infusion seleccionada.
      // Como nuestro listView filter es "getter(o) === value" o "includes", aqui
      // devolvemos un array stringificado; el passesSheet de cola hace check
      // custom abajo.
      getter: (o) => {
        const set = infusionsByOrder.get(o.id);
        return set ? [...set].join('|') : '';
      } },
  ];

  const filterRow = el('div', { class: 'flex items-center gap-2 flex-wrap mb-4' });
  const filterChips = el('div', { class: 'flex flex-wrap gap-2' });
  const sheetBtnHolder = el('div', { class: 'flex items-center gap-2 flex-wrap' });
  filterRow.append(sheetBtnHolder, filterChips);

  function passesSheet(o) {
    for (const f of sheetFilters) {
      const v = sheetValues[f.key];
      if (v == null || v.length === 0) continue;
      if (f.key === 'infusion') {
        const orderInfs = infusionsByOrder.get(o.id) || new Set();
        if (!v.some((sel) => orderInfs.has(sel))) return false;
      } else {
        if (!v.includes(f.getter(o))) return false;
      }
    }
    return true;
  }

  const list = el('div', { class: 'space-y-2' });
  function redraw() {
    // Boton de filtros (cliente + proceso)
    sheetBtnHolder.innerHTML = '';
    const fb = renderFilterButton({
      filters: sheetFilters,
      values: sheetValues,
      onChange: (v) => { sheetValues = v; redraw(); },
    });
    sheetBtnHolder.append(fb.el);

    // Chips de status (todos / sin lote / parcial / vencidos)
    filterChips.innerHTML = '';
    const baseFilteredBySheet = inFlight.filter(passesSheet);
    for (const f of FILTERS) {
      const count = baseFilteredBySheet.filter((o) => matches(o, f.key, today)).length;
      filterChips.append(el('button', {
        type: 'button',
        class: currentFilter === f.key
          ? 'ctrm-btn ctrm-btn-primary ctrm-btn-sm'
          : 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
        onClick: () => { currentFilter = f.key; redraw(); },
      }, [`${f.label}${count > 0 ? ` · ${count}` : ''}`]));
    }
    list.innerHTML = '';
    const shown = baseFilteredBySheet.filter((o) => matches(o, currentFilter, today));
    if (shown.length === 0) {
      list.append(emptyStateCard({
        title: currentFilter === 'all' ? 'Sin pedidos en curso' : 'No hay pedidos en este filtro',
        description: currentFilter === 'all'
          ? 'Cuando Forest acepte pedidos aparecerán aquí.'
          : 'Cambia el filtro o limpia para ver todos.',
      }));
      return;
    }
    if (vm.mode() === 'table') {
      list.append(queueTable(shown, today, lotsByOrder, expandedOrders, redraw, cancelOrderModal));
    } else {
      for (const o of shown) list.append(queueRow(o, today, earliest, latest, cancelOrderModal));
    }
  }
  const vm = createViewMode('finca-cola', {
    onChange: () => { redraw(); refreshLegend(); },
  });
  // Defer first redraw to after refreshLegend exists below.

  const weeklyLoadPanel = capacity?.weekly_load?.length
    ? renderWeeklyLoad(capacity.weekly_load, cherryCap)
    : null;

  // ── KPI strip arriba ──────────────────────────────────────────────
  const totalGreenPending = inFlight.reduce((s, o) => s + Number(o.pending_kg || 0), 0);
  const totalCherryPending = totalGreenPending * 7.65;
  const sinLote = inFlight.filter((o) => o.pending_kg > 0.001).length;
  const vencidos = inFlight.filter((o) =>
    o.latest_drying_start_date && o.latest_drying_start_date < today).length;
  const proximos7 = inFlight.filter((o) => {
    const d = o.latest_drying_start_date;
    if (!d || d < today) return false;
    return daysBetween(today, d) <= 7;
  }).length;
  const semanasSobrecargadas = (capacity?.weekly_load || [])
    .filter((w) => w.is_overloaded).length;

  const kpiStrip = el('div', { class: 'grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4' }, [
    kpiCard('Cereza por procesar',
      fmtKg(totalCherryPending),
      `${fmtKg(totalGreenPending)} verde por asignar`,
      totalGreenPending > 0 ? 'warn' : 'ok'),
    kpiCard('Pedidos sin lote', String(sinLote),
      sinLote > 0 ? 'Falta asignar lote' : 'Todos cubiertos',
      sinLote > 0 ? 'warn' : 'ok'),
    kpiCard('Drying en ≤7d', String(vencidos + proximos7),
      `${vencidos} vencidos · ${proximos7} próximos`,
      vencidos > 0 ? 'crit' : (proximos7 > 0 ? 'warn' : 'ok')),
    kpiCard('Semanas sobrecargadas', String(semanasSobrecargadas),
      semanasSobrecargadas > 0 ? `>${fmtKg(cherryCap)}/sem` : 'Capacidad OK',
      semanasSobrecargadas > 0 ? 'crit' : 'ok'),
  ]);

  const legendHolder = el('div', { class: 'flex items-center justify-between mb-2' });
  function refreshLegend() {
    legendHolder.innerHTML = '';
    legendHolder.append(
      vm.mode() === 'cards' ? timelineLegend() : el('span'),
      vm.toggleEl,
    );
  }
  refreshLegend();
  redraw();

  // ── Tabs: En curso / Terminados ────────────────────────────────
  // "En curso" es la cola operativa de siempre. "Terminados" es el
  // historial de pedidos Completed/Cancelled con sus baches
  // asignados, para verificar lo que ya pasó.
  const enCursoWrap = el('div', {}, [
    kpiStrip,
    weeklyLoadPanel,
    filterRow,
    legendHolder,
    list,
  ]);
  const terminadosWrap = el('div', {});
  function redrawTerminados() {
    terminadosWrap.innerHTML = '';
    if (finished.length === 0) {
      terminadosWrap.append(emptyStateCard({
        title: 'Aún no hay pedidos terminados',
        description: 'Cuando un pedido se complete o se cancele aparecerá aquí con sus baches asignados.',
      }));
      return;
    }
    terminadosWrap.append(finishedTable(finished, lotsByOrder, expandedFinished, redrawTerminados));
  }
  redrawTerminados();

  const tabBtn = (key, label, count) => el('button', {
    type: 'button',
    class: activeTab === key
      ? 'ctrm-btn ctrm-btn-primary ctrm-btn-sm'
      : 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
    onClick: () => {
      activeTab = key;
      enCursoWrap.style.display     = key === 'en_curso'   ? '' : 'none';
      terminadosWrap.style.display  = key === 'terminados' ? '' : 'none';
      tabBar.replaceChildren(
        tabBtn('en_curso', 'En curso', inFlight.length),
        tabBtn('terminados', 'Terminados', finished.length),
      );
    },
  }, [`${label} · ${count}`]);
  const tabBar = el('div', { class: 'flex items-center gap-2 mb-4' }, [
    tabBtn('en_curso', 'En curso', inFlight.length),
    tabBtn('terminados', 'Terminados', finished.length),
  ]);
  terminadosWrap.style.display = 'none';

  return chrome(el('div', {}, [
    pageTitle('Cola de pedidos', `Hoy: ${today} · drying-start = entrega − (drying + procesamiento)`),
    tabBar,
    enCursoWrap,
    terminadosWrap,
  ]));
}

// ─── Historial de terminados ────────────────────────────────────────
// Tabla expandible de pedidos Completed/Cancelled. El dropdown por
// fila reutiliza assignmentsBlock (los mismos baches + despachos que
// la cola en curso).
function finishedTable(orders, lotsByOrder, expanded, redraw) {
  const cell = (label, classes, content) => {
    const td = el('td', { class: classes });
    td.setAttribute('data-label', label);
    if (content instanceof Node) td.append(content);
    else td.append(document.createTextNode(String(content == null ? '—' : content)));
    return td;
  };
  return sortableTable({
    headers: [
      { label: '', cls: 'w-8' },
      { label: 'Código',     sortGetter: (o) => o.order_code || '' },
      { label: 'Referencia', sortGetter: (o) => o.reference_name || '' },
      { label: 'Cliente',    sortGetter: (o) => o.client_name || '' },
      { label: 'Status',     sortGetter: (o) => o.status || '' },
      { label: 'Aceptado',   cls: 'text-right', sortGetter: (o) => Number(o.kg_green_accepted || 0) },
      { label: 'Asignado',   cls: 'text-right', sortGetter: (o) => Number(o.allocated_kg || 0) },
      { label: 'Despachado', cls: 'text-right', sortGetter: (o) => Number(o.shipped_kg || 0) },
      { label: 'Cerrado el', sortGetter: (o) => o.closed_at || '' },
    ],
    defaultSort: { index: 8, dir: 'desc' },
    totals: [
      null,
      { value: (arr) => `Total · ${arr.length}`, cls: 'font-display text-[11px] uppercase tracking-eyebrow text-ink-700' },
      null, null, null,
      { value: (arr) => fmtKg(arr.reduce((s, o) => s + Number(o.kg_green_accepted || 0), 0)), cls: 'text-right font-mono font-semibold text-navy' },
      { value: (arr) => fmtKg(arr.reduce((s, o) => s + Number(o.allocated_kg || 0), 0)), cls: 'text-right font-mono font-semibold text-navy' },
      { value: (arr) => fmtKg(arr.reduce((s, o) => s + Number(o.shipped_kg || 0), 0)), cls: 'text-right font-mono font-semibold text-ok' },
      null,
    ],
    items: orders,
    renderRow: (o) => {
      const isExp = expanded.has(o.id);
      const toggle = () => {
        if (isExp) expanded.delete(o.id); else expanded.add(o.id);
        redraw();
      };
      const mainRow = el('tr', {
        class: `cursor-pointer hover:bg-cream ${isExp ? 'bg-cream' : ''}`,
        onClick: toggle,
      }, [
        cell('Expand', 'w-8 text-center', el('span', {
          class: 'text-ink-500 font-mono text-[11px]',
          text: isExp ? '▾' : '▸',
        })),
        cell('Código', 'font-mono text-navy font-semibold',
          el('button', {
            type: 'button',
            class: 'font-mono text-navy font-semibold hover:underline',
            style: 'background:none;border:none;padding:0;cursor:pointer;',
            onClick: (e) => { e.stopPropagation(); navigate(`/pedido?id=${o.id}`); },
            text: o.order_code || '—',
          })),
        cell('Referencia', '', o.reference_name || '—'),
        cell('Cliente', '', o.client_name || '—'),
        cell('Status', '', el('span', { class: `ctrm-pill ${statusPillKind(o.status)}`, text: statusLabel(o.status) })),
        cell('Aceptado',  'text-right font-mono', fmtKg(o.kg_green_accepted || 0)),
        cell('Asignado',  'text-right font-mono', fmtKg(o.allocated_kg || 0)),
        cell('Despachado', `text-right font-mono ${o.shipped_kg > 0 ? 'text-ok font-semibold' : 'text-ink-300'}`,
          o.shipped_kg > 0 ? fmtKg(o.shipped_kg) : '—'),
        cell('Cerrado el', 'font-mono text-[11px]',
          o.closed_at ? `${fmtDate(o.closed_at)} · ${relDate(o.closed_at)}` : '—'),
      ]);

      if (!isExp) return mainRow;

      const lots = lotsByOrder.get(o.id) || [];
      const subRow = el('tr', { class: 'bg-cream' }, [
        el('td', { colspan: '9', class: 'p-3' }, [assignmentsBlock(lots)]),
      ]);
      const frag = document.createDocumentFragment();
      frag.append(mainRow, subRow);
      return frag;
    },
  }).el;
}

// ─── Table renderer ────────────────────────────────────────────────
// COLSPAN = 12 (chevron + 11 columnas de datos)
function queueTable(orders, today, lotsByOrder, expanded, redraw, onCancel) {
  const cell = (label, classes, content) => {
    const td = el('td', { class: classes });
    td.setAttribute('data-label', label);
    if (content instanceof Node) td.append(content);
    else td.append(document.createTextNode(String(content == null ? '—' : content)));
    return td;
  };
  return sortableTable({
    headers: [
      { label: '', cls: 'w-8' },   // chevron
      { label: 'Código',     sortGetter: (o) => o.order_code || '' },
      { label: 'Referencia', sortGetter: (o) => o.reference_name || '' },
      { label: 'Cliente',    sortGetter: (o) => o.client_name || '' },
      { label: 'Status',     sortGetter: (o) => o.status || '' },
      { label: 'Infusión',   sortGetter: (o) => (o.infusion_names || []).join(', ') },
      { label: 'Aceptado',   cls: 'text-right', sortGetter: (o) => Number(o.kg_green_accepted || 0) },
      { label: 'Asignado',   cls: 'text-right', sortGetter: (o) => Number(o.allocated_kg || 0) },
      { label: 'Despachado', cls: 'text-right', sortGetter: (o) => Number(o.shipped_kg || 0) },
      { label: 'Pendiente',  cls: 'text-right', sortGetter: (o) => Number(o.pending_kg || 0) },
      { label: 'Drying-start', sortGetter: (o) => o.latest_drying_start_date },
      { label: 'Entrega',    sortGetter: (o) => o.max_delivery_date },
      { label: '', cls: 'w-8' },   // cancelar
    ],
    totals: [
      null,
      { value: (arr) => `Total · ${arr.length}`, cls: 'font-display text-[11px] uppercase tracking-eyebrow text-ink-700' },
      null, null, null, null,
      { value: (arr) => fmtKg(arr.reduce((s, o) => s + Number(o.kg_green_accepted || 0), 0)), cls: 'text-right font-mono font-semibold text-navy' },
      { value: (arr) => fmtKg(arr.reduce((s, o) => s + Number(o.allocated_kg || 0), 0)), cls: 'text-right font-mono font-semibold text-navy' },
      { value: (arr) => fmtKg(arr.reduce((s, o) => s + Number(o.shipped_kg || 0), 0)), cls: 'text-right font-mono font-semibold text-ok' },
      { value: (arr) => fmtKg(arr.reduce((s, o) => s + Number(o.pending_kg || 0), 0)), cls: 'text-right font-mono font-semibold text-warn' },
      null, null, null,
    ],
    items: orders,
    renderRow: (o) => {
      const isOverdue = o.latest_drying_start_date && o.latest_drying_start_date < today;
      const dryColor = isOverdue ? 'text-crit'
        : (daysBetween(today, o.latest_drying_start_date) <= 5 ? 'text-warn'
        : 'text-ink-700');
      const isExp = expanded.has(o.id);
      const toggle = () => {
        if (isExp) expanded.delete(o.id); else expanded.add(o.id);
        redraw();
      };

      const mainRow = el('tr', {
        class: `cursor-pointer hover:bg-cream ${isExp ? 'bg-cream' : ''}`,
        onClick: toggle,
      }, [
        cell('Expand', 'w-8 text-center', el('span', {
          class: 'text-ink-500 font-mono text-[11px]',
          text: isExp ? '▾' : '▸',
        })),
        cell('Código', 'font-mono text-navy font-semibold',
          el('span', { class: 'inline-flex items-center gap-1.5' }, [
            el('button', {
              type: 'button',
              class: 'font-mono text-navy font-semibold hover:underline',
              style: 'background:none;border:none;padding:0;cursor:pointer;',
              onClick: (e) => { e.stopPropagation(); navigate(`/pedido?id=${o.id}`); },
              text: o.order_code || '—',
            }),
            requestInfoButton(o),
          ])),
        cell('Referencia', '', o.reference_name || '—'),
        cell('Cliente', '', o.client_name || '—'),
        cell('Status', '', el('span', { class: `ctrm-pill ${statusPillKind(o.status)}`, text: statusLabel(o.status) })),
        cell('Infusión', 'text-[11px]', (o.infusion_names || []).length
          ? el('span', { class: 'ctrm-pill', style: 'background:#fbe6c2;color:#8a5100;', text: o.infusion_names.join(', ') })
          : '—'),
        cell('Aceptado',  'text-right font-mono', fmtKg(o.kg_green_accepted || 0)),
        cell('Asignado',  'text-right font-mono', fmtKg(o.allocated_kg || 0)),
        cell('Despachado', `text-right font-mono ${o.shipped_kg > 0 ? 'text-ok font-semibold' : 'text-ink-300'}`,
          o.shipped_kg > 0 ? fmtKg(o.shipped_kg) : '—'),
        cell('Pendiente', `text-right font-mono ${o.pending_kg > 0 ? 'text-warn font-bold' : 'text-ink-300'}`,
          fmtKg(o.pending_kg || 0)),
        cell('Drying-start', `font-mono text-[11px] ${dryColor}`,
          o.latest_drying_start_date ? `${fmtDate(o.latest_drying_start_date)} · ${relDate(o.latest_drying_start_date)}` : '—'),
        cell('Entrega', 'font-mono text-[11px]',
          o.max_delivery_date ? `${fmtDate(o.max_delivery_date)} · ${relDate(o.max_delivery_date)}` : '—'),
        cell('Cancelar', 'w-8 text-center', onCancel
          ? el('button', {
              type: 'button',
              class: 'text-crit text-[14px] font-bold hover:bg-crit-bg rounded px-1.5 py-0.5',
              title: 'Cancelar pedido',
              style: 'background:none;border:none;cursor:pointer;',
              onClick: (e) => { e.stopPropagation(); onCancel(o); },
            }, ['×'])
          : document.createTextNode('')),
      ]);

      if (!isExp) return mainRow;

      const lots = lotsByOrder.get(o.id) || [];
      const subRow = el('tr', { class: 'bg-cream' }, [
        el('td', { colspan: '13', class: 'p-3' }, [assignmentsBlock(lots)]),
      ]);
      const frag = document.createDocumentFragment();
      frag.append(mainRow, subRow);
      return frag;
    },
  }).el;
}

// Mini-tabla con los baches asignados a un pedido específico. Cada
// fila: bache · status · proceso · variedad · kg verde asignado a
// ESTE pedido · pills de despachos que lo cubrieron para este pedido.
function assignmentsBlock(lots) {
  if (lots.length === 0) {
    return el('p', { class: 'text-[12px] text-ink-300 italic px-1',
      text: 'Este pedido no tiene baches asignados todavía.' });
  }
  const total = lots.reduce((s, x) => s + Number(x.kg_green_allocated || 0), 0);
  return el('div', { class: 'space-y-2' }, [
    el('p', { class: 'eyebrow text-[10px]', text: `Asignaciones (${lots.length})` }),
    el('div', { class: 'overflow-x-auto bg-white rounded-md border border-sand' }, [
      el('table', { class: 'w-full text-[11px]' }, [
        el('thead', {}, [el('tr', { class: 'bg-cream text-ink-500 uppercase tracking-eyebrow text-[9px]' }, [
          el('th', { class: 'px-3 py-1.5 text-left', text: 'Bache' }),
          el('th', { class: 'px-3 py-1.5 text-left', text: 'Status' }),
          el('th', { class: 'px-3 py-1.5 text-left', text: 'Proceso' }),
          el('th', { class: 'px-3 py-1.5 text-left', text: 'Variedad' }),
          el('th', { class: 'px-3 py-1.5 text-right', text: 'kg verde asignado' }),
          el('th', { class: 'px-3 py-1.5 text-left', text: 'Despacho(s)' }),
        ])]),
        el('tbody', {}, lots.map(({ lot, kg_green_allocated, shipments: shipPills }) => {
          const varieties = (lot.varieties || []).map((v) => v.name).join(', ') || '—';
          return el('tr', { class: 'border-t border-sand hover:bg-cream' }, [
            el('td', { class: 'px-3 py-1.5' }, [
              el('button', {
                type: 'button',
                class: 'font-mono text-navy font-semibold hover:underline',
                style: 'background:none;border:none;padding:0;cursor:pointer;',
                onClick: (e) => { e.stopPropagation(); navigate(`/finca/bache?id=${lot.id}`); },
                text: lot.bache_code || lot.blend_code || lot.lot_code || '—',
              }),
            ]),
            el('td', { class: 'px-3 py-1.5' }, [
              el('span', { class: `ctrm-pill text-[9px] ${statusPillKind(lot.status)}`, text: statusLabel(lot.status) }),
            ]),
            el('td', { class: 'px-3 py-1.5', text: lot.process_type || '—' }),
            el('td', { class: 'px-3 py-1.5 text-ink-500', text: varieties }),
            el('td', { class: 'px-3 py-1.5 text-right font-mono font-bold text-navy',
              text: fmtKg(kg_green_allocated) }),
            el('td', { class: 'px-3 py-1.5' }, [
              shipPills.length === 0
                ? el('span', { class: 'text-ink-300 italic', text: '—' })
                : el('div', { class: 'flex flex-wrap gap-1' },
                    shipPills.map((s) => el('button', {
                      type: 'button',
                      class: 'ctrm-pill text-[9px] cursor-pointer hover:opacity-80',
                      style: 'background:#dbeafe;color:#1a3a5c;',
                      title: `${fmtDate(s.shipment_date)} · ${fmtKg(s.kg)}`,
                      onClick: (e) => { e.stopPropagation(); navigate(`/finca/despachos?focus=${s.shipment_id}`); },
                      text: s.shipment_code,
                    }))),
            ]),
          ]);
        })),
        el('tfoot', {}, [el('tr', { class: 'border-t-2 border-ink-300 bg-cream' }, [
          el('td', { colspan: '4', class: 'px-3 py-1.5 font-display text-[10px] uppercase tracking-eyebrow text-ink-700 text-right',
            text: 'Total asignado a este pedido' }),
          el('td', { class: 'px-3 py-1.5 text-right font-mono font-bold text-navy', text: fmtKg(total) }),
          el('td', {}, []),
        ])]),
      ]),
    ]),
  ]);
}

function kpiCard(label, value, hint, kind) {
  const valClass = kind ? `stat-val ${kind}` : 'stat-val';
  return el('div', { class: 'stat-card' }, [
    el('p', { class: 'stat-label', text: label }),
    el('p', { class: valClass, text: String(value) }),
    el('p', { class: 'stat-sub', text: hint }),
  ]);
}

// ─── Weekly load panel ──────────────────────────────────────────────
function renderWeeklyLoad(weeklyLoad, cap) {
  const sorted = weeklyLoad.slice().sort((a, b) => a.week_start_date.localeCompare(b.week_start_date));
  const hasOverload = sorted.some((w) => w.is_overloaded);
  return el('section', { class: 'ctrm-card ctrm-card-pad mb-4' }, [
    el('div', { class: 'flex items-baseline justify-between flex-wrap gap-2 mb-2' }, [
      el('p', { class: 'eyebrow', text: 'Carga semanal (kg cereza)' }),
      el('p', { class: 'text-[11px] text-ink-500 font-mono' }, [
        `Capacidad: `, el('strong', { class: 'text-ink-700', text: fmtKg(cap) }), ` / semana`,
        hasOverload
          ? el('span', { class: 'text-crit', text: ' · alguna semana sobrecargada' })
          : null,
      ]),
    ]),
    el('div', { class: 'space-y-1.5' }, sorted.map((w) => weekRow(w, cap))),
  ]);
}

function weekRow(w, cap) {
  const total = Number(w.total_cherry_kg ?? (w.selected_orders_kg_cherry || 0) + (w.active_queue_kg_cherry || 0));
  const pct = cap > 0 ? Math.min(150, (total / cap) * 100) : 0;
  const over = w.is_overloaded;
  const color = over ? '#c45a4f' : pct > 80 ? '#ddae3e' : '#5d8b66';
  return el('div', { class: 'flex items-center gap-2 text-[12px]' }, [
    el('div', { class: 'w-20 shrink-0 font-mono text-[11px] text-ink-500', text: w.iso_week_key }),
    el('div', { class: 'flex-1 h-5 bg-cream rounded-md relative overflow-hidden border border-sand' }, [
      el('div', {
        class: 'absolute inset-y-0 left-0',
        style: `width:${Math.min(100, pct)}%;background:${color};`,
        title: `${fmtKg(total)} de ${fmtKg(cap)} (${(pct).toFixed(0)}%)`,
      }),
      // Marca del 100% para referencia visual
      el('div', {
        class: 'absolute inset-y-0',
        style: 'left:100%;width:2px;background:rgba(0,0,0,.15);',
      }),
    ]),
    el('div', { class: 'w-32 shrink-0 text-right font-mono text-[11px]' }, [
      el('strong', { class: over ? 'text-crit' : 'text-ink-700', text: fmtKg(total) }),
      el('span', { class: 'text-ink-300', text: ` · ${pct.toFixed(0)}%` }),
    ]),
  ]);
}

// ─── Filtros ────────────────────────────────────────────────────────
function matches(o, filter, today) {
  const isOverdue = o.latest_drying_start_date && o.latest_drying_start_date < today;
  const noLot     = (o.allocated_kg || 0) <= 0.001;
  const partial   = (o.allocated_kg || 0) > 0.001
    && (o.pending_kg || 0) > 0.001;

  switch (filter) {
    case 'no-lot':      return noLot;
    case 'partial-lot': return partial;
    case 'overdue':     return isOverdue;
    case 'all':
    default:            return true;
  }
}

// ─── Row + timeline ─────────────────────────────────────────────────
// La card unificada vive en _order-card.js (compartida con Forest).
// Aquí encima/abajo le agregamos los hints específicos de la cola:
// timeline horizontal de fechas + pills de urgencia/sobrecarga.
function queueRow(o, today, earliest, latest, onCancel) {
  const isOverdue = o.latest_drying_start_date && o.latest_drying_start_date < today;
  const dryingPos = posOn(earliest, latest, o.latest_drying_start_date);
  const delivPos  = posOn(earliest, latest, o.max_delivery_date);
  const dryDelta = daysBetween(today, o.latest_drying_start_date);
  const dryColor = isOverdue ? '#c45a4f'
                  : (dryDelta != null && dryDelta < 5) ? '#8a5100'
                  : '#7e9ec1';

  // Pills específicos de la cola (no van en el componente unificado)
  const colaPills = el('div', { class: 'flex flex-wrap items-center gap-1.5 px-3 pb-1' }, [
    ...(o.infusion_names || []).map((n) => el('span', {
      class: 'ctrm-pill',
      style: 'background:#fbe6c2;color:#8a5100;',
      text: n,
    })),
    isOverdue ? el('span', { class: 'ctrm-pill urgency-red', text: 'Drying vencido' }) : null,
    o.week_bucket && o.week_bucket.is_overloaded
      ? el('span', {
          class: 'ctrm-pill urgency-red',
          title: `Semana ${o.week_bucket.iso_week_key} con ${fmtKg(o.week_bucket.total_cherry_kg)} cereza (capacidad ${fmtKg(o.week_bucket.capacity_kg)})`,
          text: 'Semana sobrecargada',
        })
      : null,
  ]);
  const hasColaPills = colaPills.children.length > 0;

  const card = renderOrderCard(o, {
    role: 'finca',
    rollup: {
      assigned_kg: Number(o.allocated_kg || 0),
      shipped_kg:  Number(o.shipped_kg || 0),
      pending_kg:  Number(o.pending_kg || 0),
    },
    callbacks: {
      onAssign: () => navigate('/finca/lots'),
    },
    secondaryActions: [
      { label: 'Ver detalle', onClick: () => navigate(`/pedido?id=${o.id}`) },
      onCancel ? { label: 'Cancelar pedido', danger: true, onClick: () => onCancel(o) } : null,
    ],
  });

  // Agregamos pills de cola + timeline después del cuerpo de la card.
  if (hasColaPills) card.append(colaPills);
  card.append(el('div', { class: 'px-3 pb-3' }, [
    timeline(today, earliest, latest, dryingPos, delivPos, dryColor, o),
  ]));
  return card;
}

function noLotOrPartialButton(o, allocated, pending) {
  const accepted = Number(o.kg_green_accepted || 0);
  const surplus = allocated - accepted;
  if (pending > 0.001) {
    return el('button', {
      class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm shrink-0',
      onClick: () => navigate('/finca/lots'),
    }, [allocated > 0.001 ? 'Asignar más' : 'Asignar lote']);
  }
  if (surplus > 0.001) {
    return el('span', {
      class: 'ctrm-pill roll text-[10px]',
      title: `Asignado ${allocated} kg verde sobre ${accepted} aceptados`,
      text: `Excedente +${fmtKg(surplus)}`,
    });
  }
  return el('span', { class: 'ctrm-pill ok text-[10px]', text: 'Cubierto' });
}

function timeline(today, earliest, latest, dryingPos, delivPos, dryColor, o) {
  return el('div', {}, [
    el('div', { class: 'relative h-7' }, [
      // Track
      el('div', { class: 'absolute inset-y-3 left-0 right-0 h-px bg-sand' }),
      // Today marker — siempre en posición 0
      markerEl(0, '#1b203d', 'Hoy'),
      // Drying-start marker
      o.latest_drying_start_date
        ? markerEl(dryingPos, dryColor,
            `Drying-start ${fmtDate(o.latest_drying_start_date)} (${relDate(o.latest_drying_start_date)})`)
        : null,
      // Delivery marker
      o.max_delivery_date
        ? markerEl(delivPos, '#5d8b66',
            `Entrega ${fmtDate(o.max_delivery_date)} (${relDate(o.max_delivery_date)})`)
        : null,
    ]),
    el('div', { class: 'flex justify-between text-[10px] text-ink-300 font-mono mt-0.5' }, [
      el('span', { text: 'Hoy' }),
      o.latest_drying_start_date
        ? el('span', {}, [
            `Drying-start: `,
            el('strong', {
              style: `color:${dryColor};`,
              text: `${fmtDate(o.latest_drying_start_date)} (${relDate(o.latest_drying_start_date)})`,
            }),
          ])
        : null,
      o.max_delivery_date
        ? el('span', {}, [
            `Entrega: `,
            el('strong', { class: 'text-ink-700', text: `${fmtDate(o.max_delivery_date)}` }),
          ])
        : null,
    ]),
  ]);
}

function markerEl(pct, color, title) {
  return el('div', {
    class: 'absolute top-1.5',
    style: `left:${pct}%;transform:translateX(-50%);`,
    title,
  }, [
    el('div', {
      class: 'w-3 h-3 rounded-full border-2 border-white',
      style: `background:${color};box-shadow:0 0 0 1px ${color};`,
    }),
  ]);
}

function timelineLegend() {
  return el('div', { class: 'flex items-center gap-4 text-[10px] text-ink-500 font-mono mb-3 px-2' }, [
    legendDot('#1b203d', 'Hoy'),
    legendDot('#7e9ec1', 'Drying-start'),
    legendDot('#5d8b66', 'Entrega'),
    el('span', { class: 'text-ink-300', text: '· Rojo = vencido · Naranja = <5d' }),
  ]);
}

function legendDot(color, text) {
  return el('span', { class: 'inline-flex items-center gap-1' }, [
    el('span', {
      class: 'inline-block w-2.5 h-2.5 rounded-full border border-white',
      style: `background:${color};box-shadow:0 0 0 1px ${color};`,
    }),
    text,
  ]);
}

// ─── Helpers ───────────────────────────────────────────────────────
function posOn(start, end, target) {
  if (!target) return 0;
  const a = new Date(start + 'T12:00:00Z').getTime();
  const b = new Date(end   + 'T12:00:00Z').getTime();
  const t = new Date(target + 'T12:00:00Z').getTime();
  if (b <= a) return 100;
  const pct = ((t - a) / (b - a)) * 100;
  return Math.max(0, Math.min(100, pct));
}

function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const a = new Date(fromIso + 'T00:00:00Z').getTime();
  const b = new Date(toIso   + 'T00:00:00Z').getTime();
  return Math.floor((b - a) / 86400000);
}

function meta(label, value) {
  return el('span', { class: 'inline-flex items-baseline gap-1' }, [
    el('span', { class: 'text-ink-300 uppercase tracking-loose text-[10px] font-sans font-semibold', text: label }),
    el('strong', { class: 'text-ink-700 font-mono', text: String(value) }),
  ]);
}

// Botón mini "ⓘ" que abre un popover anclado con los datos de
// solicitud del pedido (aspecto, intensidad, comentario de Forest).
// Para uso en cards y filas de tabla en /finca/cola.
function requestInfoButton(o) {
  return el('button', {
    type: 'button',
    class: 'inline-flex items-center justify-center w-4 h-4 rounded-full border border-ink-300 text-ink-500 text-[9px] font-bold leading-none hover:bg-navy hover:text-yellow hover:border-navy shrink-0',
    title: 'Ver detalles de la solicitud',
    onClick: (e) => {
      e.stopPropagation();
      openPopover({
        anchor: e.currentTarget,
        title: 'Solicitud del pedido',
        subtitle: o.order_code,
        body: requestInfoBody(o),
      });
    },
  }, ['i']);
}

function requestInfoBody(o) {
  const row = (label, value, opts = {}) => {
    const hasVal = value != null && value !== '';
    return el('div', { class: 'mb-2 last:mb-0' }, [
      el('p', { class: 'text-[9px] uppercase tracking-loose text-ink-500 mb-0.5 font-semibold', text: label }),
      el('p', {
        class: hasVal
          ? `text-[12px] text-ink-700 ${opts.wrap ? 'whitespace-pre-line' : ''}`
          : 'text-[12px] text-ink-300 italic',
        text: hasVal ? String(value) : '—',
      }),
    ]);
  };
  return el('div', {}, [
    row('Cliente', o.client_name),
    row('Aspecto físico', o.physical_aspect),
    row('Intensidad', fmtIntensity(o.intensity)),
    row('Comentario de Forest', o.comments, { wrap: true }),
  ]);
}
