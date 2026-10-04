// Historial de pedidos de Forest — tabla de seguimiento.
//
// Responde la pregunta que el tablero de tarjetas no contesta de un
// vistazo: de todos mis pedidos, ¿cuáles están despachados, cuáles
// van tarde y cuánto falta de cada uno.
//
// Muestra TODOS los estados con filtro, no solo los cerrados: para
// hacer seguimiento hay que ver los vivos.

import { el, clear } from '../ui/el.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { sortableTable } from '../ui/sortable-table.js';
import { navigate } from '../router.js';
import {
  fmtKg, fmtDate, statusLabel, statusPillKind,
  fmtDaysLeft, daysLeftClass, fmtPendingDelta,
} from '../ui/format.js';

// Agrupaciones del filtro. 'activos' es el default: es lo que uno
// mira para hacer seguimiento.
const STATUS_GROUPS = {
  activos:    ['Pending', 'Accepted', 'PartiallyAccepted', 'InProduction'],
  cerrados:   ['Completed'],
  caidos:     ['Cancelled', 'Rejected'],
};

/**
 * kg asignados y despachados por pedido.
 *
 * "Despachado" se deriva de los registros de despacho
 * (shipments[].lots[].assignments), NO del estado del bache: desde la
 * migración 0030 un bache puede despacharse parcialmente y queda en
 * Ready, así que mirar el estado subestimaría lo despachado.
 *
 * Misma definición que usa /finca/cola, para que Forest y El Vergel
 * vean el mismo número. (finca-cola y forest-dashboard tienen cada uno
 * su copia de este cálculo; unificarlos es limpieza aparte.)
 */
function buildOrderTotals(lots, shipments) {
  const totals = new Map();   // order_id → { assigned_kg, shipped_kg }
  const touch = (oid) => {
    if (!totals.has(oid)) totals.set(oid, { assigned_kg: 0, shipped_kg: 0 });
    return totals.get(oid);
  };

  for (const lot of lots || []) {
    for (const a of lot.assignments || []) {
      const oid = a.demand_order_id || (a.order && a.order.id);
      if (!oid) continue;
      touch(oid).assigned_kg += Number(a.kg_green_allocated || 0);
    }
  }
  for (const s of shipments || []) {
    for (const l of s.lots || []) {
      for (const a of l.assignments || []) {
        const oid = (a.order && a.order.id) || a.demand_order_id;
        if (!oid) continue;
        touch(oid).shipped_kg += Number(a.kg_green_allocated || 0);
      }
    }
  }
  return totals;
}

/** Pill de despacho: la respuesta corta a "¿ya salió?". */
function dispatchPill(target, shipped) {
  if (!(shipped > 0)) {
    return el('span', { class: 'ctrm-pill muted text-[10px]', text: 'Sin despachar' });
  }
  if (target > 0 && shipped + 1e-6 >= target) {
    return el('span', { class: 'ctrm-pill ok text-[10px]', text: 'Despachado' });
  }
  const pct = target > 0 ? Math.round((shipped / target) * 100) : 0;
  return el('span', { class: 'ctrm-pill warn text-[10px]', text: `Parcial ${pct}%` });
}

export async function forestHistorialView() {
  const [ordersRes, lotsRes, shipsRes] = await Promise.all([
    api.ordersList({}),            // sin filtro: todos los estados
    api.lotsList({}),              // incluye Delivered para el rollup
    api.shipmentsList(),
  ]);

  const allOrders = ordersRes.orders || [];
  const totals = buildOrderTotals(lotsRes.lots || [], shipsRes.shipments || []);

  const rows = allOrders.map((o) => {
    const t = totals.get(o.id) || { assigned_kg: 0, shipped_kg: 0 };
    // El objetivo real es lo que la finca aceptó; en Pending todavía no
    // hay compromiso, así que se muestra lo requerido.
    const target = Number(o.kg_green_accepted != null ? o.kg_green_accepted : o.kg_green_required || 0);
    return {
      ...o,
      target_kg:   target,
      assigned_kg: t.assigned_kg,
      shipped_kg:  t.shipped_kg,
      cover_pct:   target > 0 ? Math.min(100, (t.assigned_kg / target) * 100) : 0,
      ship_pct:    target > 0 ? Math.min(100, (t.shipped_kg / target) * 100) : 0,
    };
  });

  // ── Filtros ─────────────────────────────────────────────────────
  let group = 'activos';
  let search = '';

  const groupSelect = el('select', { class: 'ctrm-select text-[12px]' }, [
    el('option', { value: 'activos', selected: true }, ['Activos']),
    el('option', { value: 'cerrados' },                ['Completados']),
    el('option', { value: 'caidos' },                  ['Cancelados y rechazados']),
    el('option', { value: 'todos' },                   ['Todos']),
  ]);
  const searchInput = el('input', {
    type: 'search', placeholder: 'Pedido, cliente o referencia…',
    class: 'ctrm-input text-[12px]',
  });

  const countLabel = el('p', { class: 'text-[11px] text-ink-500 font-mono' });
  const tableWrap = el('div', {});

  function visibleRows() {
    const allowed = group === 'todos' ? null : new Set(STATUS_GROUPS[group] || []);
    const q = search.trim().toLowerCase();
    return rows.filter((o) => {
      if (allowed && !allowed.has(o.status)) return false;
      if (!q) return true;
      return [o.order_code, o.client_name, o.reference_name, o.contract_code]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }

  function redraw() {
    const items = visibleRows();
    countLabel.textContent = `${items.length} de ${rows.length} pedidos`;

    const cell = (label, classes, content) => {
      const td = el('td', { class: classes });
      td.setAttribute('data-label', label);
      if (content instanceof Node) td.append(content);
      else td.append(document.createTextNode(String(content == null ? '—' : content)));
      return td;
    };

    const headers = [
      { label: 'Pedido',      sortGetter: (o) => o.order_code },
      { label: 'Cliente',     sortGetter: (o) => o.client_name || '' },
      { label: 'Referencia',  sortGetter: (o) => o.reference_name || '' },
      { label: 'Estado',      sortGetter: (o) => statusLabel(o.status) },
      { label: 'Objetivo',    sortGetter: (o) => o.target_kg,   cls: 'text-right' },
      { label: 'Asignado',    sortGetter: (o) => o.assigned_kg, cls: 'text-right' },
      { label: 'Despachado',  sortGetter: (o) => o.shipped_kg,  cls: 'text-right' },
      { label: 'Cobertura',   sortGetter: (o) => o.cover_pct,   cls: 'text-right' },
      { label: 'Entrega',     sortGetter: (o) => o.max_delivery_date || '' },
      { label: 'Días',        sortGetter: (o) => o.days_to_delivery, cls: 'text-right' },
      { label: 'Despacho',    sortGetter: (o) => o.ship_pct },
    ];

    const sumKg = (arr, k) => fmtKg(arr.reduce((s, o) => s + Number(o[k] || 0), 0));
    const totalsRow = [
      { label: 'Total', value: () => 'Total', cls: 'font-semibold text-ink-700' },
      null, null, null,
      { value: (arr) => sumKg(arr, 'target_kg'),   cls: 'text-right font-mono font-semibold' },
      { value: (arr) => sumKg(arr, 'assigned_kg'), cls: 'text-right font-mono' },
      { value: (arr) => sumKg(arr, 'shipped_kg'),  cls: 'text-right font-mono font-semibold text-ok' },
      null, null, null, null,
    ];

    const t = sortableTable({
      headers,
      items,
      defaultSort: { index: 9, dir: 'asc' },   // los más urgentes arriba
      totals: totalsRow,
      renderRow: (o) => el('tr', { class: 'border-t border-sand hover:bg-sand/40' }, [
        cell('Pedido', 'px-2 py-2', el('button', {
          type: 'button',
          class: 'font-mono text-navy font-semibold hover:underline',
          style: 'background:none;border:none;padding:0;cursor:pointer;',
          onClick: () => navigate(`/pedido?id=${o.id}`),
          text: o.order_code || '—',
        })),
        cell('Cliente', 'px-2 py-2 text-[12px]', o.client_name || '—'),
        cell('Referencia', 'px-2 py-2 text-[12px]', o.reference_name || '—'),
        cell('Estado', 'px-2 py-2', el('div', { class: 'flex items-center gap-1 flex-wrap' }, [
          el('span', { class: `ctrm-pill ${statusPillKind(o.status)} text-[10px]`, text: statusLabel(o.status) }),
          // Ajuste de kg pendiente de que la finca lo resuelva (0050).
          fmtPendingDelta(o.kg_green_pending_delta)
            ? el('span', {
                class: 'ctrm-pill text-[10px]',
                style: 'background:#fef3c7;color:#92400e;border-color:#fcd34d;',
                text: `⇅ ${fmtPendingDelta(o.kg_green_pending_delta)}`,
              })
            : null,
        ])),
        cell('Objetivo', 'px-2 py-2 text-right font-mono', fmtKg(o.target_kg)),
        cell('Asignado', 'px-2 py-2 text-right font-mono', fmtKg(o.assigned_kg)),
        cell('Despachado', `px-2 py-2 text-right font-mono ${o.shipped_kg > 0 ? 'text-ok font-semibold' : 'text-ink-300'}`,
          o.shipped_kg > 0 ? fmtKg(o.shipped_kg) : '—'),
        cell('Cobertura', 'px-2 py-2 text-right font-mono', `${Math.round(o.cover_pct)}%`),
        cell('Entrega', 'px-2 py-2 font-mono text-[12px]', o.max_delivery_date ? fmtDate(o.max_delivery_date) : '—'),
        // Los días solo informan mientras el pedido está vivo; en uno
        // cerrado o cancelado el plazo ya no significa nada.
        cell('Días', `px-2 py-2 text-right font-mono ${
          ['Completed', 'Cancelled', 'Rejected'].includes(o.status) ? 'text-ink-300' : daysLeftClass(o.days_to_delivery)
        }`, ['Completed', 'Cancelled', 'Rejected'].includes(o.status) ? '—' : fmtDaysLeft(o.days_to_delivery)),
        cell('Despacho', 'px-2 py-2', dispatchPill(o.target_kg, o.shipped_kg)),
      ]),
    });

    clear(tableWrap);
    tableWrap.append(items.length === 0
      ? el('div', { class: 'ctrm-card ctrm-card-pad text-center' }, [
          el('p', { class: 'text-[12px] text-ink-300 italic', text: 'Ningún pedido con ese filtro.' }),
        ])
      : t.el);
  }

  groupSelect.addEventListener('change', () => { group = groupSelect.value; redraw(); });
  searchInput.addEventListener('input', () => { search = searchInput.value; redraw(); });

  redraw();

  return chrome(el('div', {}, [
    pageTitle('Historial de pedidos', 'Seguimiento de estado y despacho'),
    el('div', { class: 'flex items-end gap-2 flex-wrap mb-3' }, [
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'Estado' }), groupSelect]),
      el('div', { class: 'flex-1 min-w-[180px]' }, [
        el('label', { class: 'ctrm-label', text: 'Buscar' }), searchInput,
      ]),
      el('div', { class: 'pb-2' }, [countLabel]),
    ]),
    tableWrap,
  ]));
}
