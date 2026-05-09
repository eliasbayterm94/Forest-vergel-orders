// "Rejection → purchase order trigger" view.
// Lists orders that need external sourcing (Rejected, PartiallyAccepted)
// with the kg-needed-externally figure. MVP: display only — no PO state
// is tracked in this system.
import { el } from '../ui/el.js';
import { fmtKg, fmtDate, statusLabel } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';

export async function forestExternalPosView() {
  const res = await api.ordersList({ status: 'Rejected,PartiallyAccepted,InProduction,Completed' });
  // We want orders with external need. Easiest: filter client-side on >0.
  const rows = res.orders.filter((o) => Number(o.kg_green_external_needed || 0) > 0);

  const totalKg = rows.reduce((s, o) => s + Number(o.kg_green_external_needed || 0), 0);

  return chrome(el('div', {}, [
    pageTitle('Pedidos a sourcing externo', 'Rechazos y aceptaciones parciales que requieren PO con un tercero'),
    el('div', { class: 'mb-4 bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900' }, [
      `Total a buscar externamente: `, el('strong', { text: fmtKg(totalKg) }),
    ]),
    rows.length === 0
      ? el('p', { class: 'text-sm text-slate-400 italic px-1', text: 'Nada pendiente. Todos los rechazos están al día.' })
      : el('div', { class: 'space-y-2' }, rows.map(extRow)),
  ]));
}

function extRow(o) {
  return el('div', { class: 'bg-white rounded-xl border border-slate-200 p-3 sm:p-4' }, [
    el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-1' }, [
      el('div', { class: 'flex items-center gap-2 min-w-0' }, [
        el('span', { class: 'font-mono text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700', text: o.order_code }),
        el('span', { class: 'font-medium text-slate-900 truncate', text: o.reference_name || '—' }),
      ]),
      el('span', { class: 'text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-900', text: statusLabel(o.status) }),
    ]),
    el('div', { class: 'flex flex-wrap text-xs text-slate-600 gap-x-4 gap-y-1' }, [
      el('span', {}, [`A externalizar: `, el('strong', { class: 'text-amber-900', text: fmtKg(o.kg_green_external_needed) })]),
      el('span', {}, [`Solicitado: `, el('strong', { text: fmtKg(o.kg_green_required) })]),
      o.kg_green_accepted != null ? el('span', {}, [`Aceptado por finca: `, el('strong', { text: fmtKg(o.kg_green_accepted) })]) : null,
      el('span', {}, [`Entrega: `, el('strong', { text: fmtDate(o.max_delivery_date) })]),
      el('span', {}, [`Proceso: `, el('strong', { text: o.process_type })]),
      el('span', {}, [`Aspecto: `, el('strong', { text: o.physical_aspect })]),
    ]),
    o.rejection_reason ? el('p', { class: 'text-xs text-slate-500 mt-1 italic' }, [`Motivo: ${o.rejection_reason}`]) : null,
  ]);
}
