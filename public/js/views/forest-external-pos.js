// "Rejection → purchase order trigger" view — CTRM-styled.
import { el } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { openModal } from '../ui/modal.js';
import { listView, sumOf } from '../ui/list.js';
import { fmtKg, fmtDate, statusLabel } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';

const PO_STATUSES = ['Pendiente', 'Emitida', 'Recibida', 'Cancelada'];

const PO_PILL_KIND = {
  Pendiente: 'warn',
  Emitida:   'roll',
  Recibida:  'ok',
  Cancelada: 'muted',
};

export async function forestExternalPosView() {
  const res = await api.ordersList({ status: 'Rejected,PartiallyAccepted,InProduction,Completed' });
  const rows = res.orders.filter((o) => Number(o.kg_green_external_needed || 0) > 0);

  return chrome(el('div', {}, [
    pageTitle('Pedidos a sourcing externo', 'Rechazos y aceptaciones parciales que requieren PO con un tercero'),

    listView({
      items: rows,
      renderItem: (o) => extRow(o, () => openPoEdit(o)),
      pageSize: 20,
      emptyText: 'Nada pendiente. Todos los rechazos están al día.',
      searchPlaceholder: 'Buscar código, cliente, contrato, proveedor...',
      searchMatch: (o, q) => {
        const lo = q.toLowerCase();
        return [o.order_code, o.client_name, o.contract_code, o.reference_name, o.external_po_supplier, o.external_po_code]
          .some((s) => (s || '').toLowerCase().includes(lo));
      },
      filters: [
        {
          key: 'po_status',
          label: 'Estado PO',
          options: PO_STATUSES,
          getter: (o) => o.external_po_status || 'Pendiente',
        },
        {
          key: 'order_status',
          label: 'Estado pedido',
          options: ['Rejected', 'PartiallyAccepted'],
          optionLabels: { Rejected: 'Rechazado', PartiallyAccepted: 'Aceptado parcial' },
          getter: (o) => o.status,
        },
        {
          key: 'client_name',
          label: 'Cliente',
          multi: true,
          options: [...new Set(rows.map((o) => o.client_name).filter(Boolean))].sort(),
          getter: (o) => o.client_name || '',
        },
      ],
      sorts: [
        { key: 'date_asc',  label: 'Entrega: más cercana', getter: (o) => o.max_delivery_date, dir: 'asc' },
        { key: 'date_desc', label: 'Entrega: más lejana',  getter: (o) => o.max_delivery_date, dir: 'desc' },
        { key: 'kg_desc',   label: 'Mayor kg externo',     getter: (o) => Number(o.kg_green_external_needed || 0), dir: 'desc' },
        { key: 'kg_asc',    label: 'Menor kg externo',     getter: (o) => Number(o.kg_green_external_needed || 0), dir: 'asc' },
      ],
      defaultSort: 'date_asc',
      totals: [
        { label: 'Pedidos',       value: (arr) => String(arr.length) },
        { label: 'Total externo', value: (arr) => fmtKg(sumOf(arr, 'kg_green_external_needed')) },
        { label: 'Pendiente PO',  value: (arr) => fmtKg(sumOfBy(arr, (o) => (o.external_po_status || 'Pendiente') === 'Pendiente' ? Number(o.kg_green_external_needed || 0) : 0)) },
        { label: 'PO Emitida',    value: (arr) => fmtKg(sumOfBy(arr, (o) => o.external_po_status === 'Emitida' ? Number(o.kg_green_external_needed || 0) : 0)) },
      ],
    }),
  ]));

  async function openPoEdit(order) {
    const result = await openPoModal(order);
    if (!result) return;
    try {
      await api.orderUpdatePo({ order_id: order.id, ...result });
      toast(`PO de ${order.order_code} actualizado`, 'success');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (e) { toast(e.message || 'Error al actualizar PO', 'error'); }
  }
}

function sumOfBy(arr, fn) {
  return arr.reduce((s, x) => s + Number(fn(x) || 0), 0);
}

function extRow(o, onEditPo) {
  const isReject = o.status === 'Rejected';
  const poStatus = o.external_po_status || 'Pendiente';
  const poKind   = PO_PILL_KIND[poStatus] || 'muted';

  return el('div', { class: `ctrm-card ctrm-card-pad border-l-4 ${isReject ? 'border-l-crit' : 'border-l-warn'}` }, [
    el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-2' }, [
      el('div', { class: 'flex items-center gap-2 min-w-0 flex-wrap' }, [
        el('span', { class: 'ctrm-code', text: o.order_code }),
        el('span', { class: 'font-display font-semibold text-navy text-[13px] truncate', text: o.reference_name || '—' }),
        o.order_type ? el('span', { class: 'ctrm-pill dark', text: o.order_type }) : null,
        el('span', { class: `ctrm-pill ${isReject ? 'crit' : 'warn'}`, text: statusLabel(o.status) }),
      ]),
      el('div', { class: 'flex items-center gap-2' }, [
        el('span', { class: 'eyebrow text-[9px]', text: 'PO' }),
        el('span', { class: `ctrm-pill ${poKind}`, text: poStatus }),
        el('button', {
          class: 'ctrm-btn ctrm-btn-soft ctrm-btn-xs',
          onClick: onEditPo,
        }, ['Editar PO']),
      ]),
    ]),
    (o.client_name || (o.regions && o.regions.length) || o.contract_code)
      ? el('div', { class: 'flex flex-wrap text-[11px] text-ink-500 gap-x-3 gap-y-0.5 mb-1.5' }, [
          o.client_name  ? meta('Cliente', o.client_name) : null,
          o.regions && o.regions.length ? meta('Regiones', o.regions.join(' · ')) : null,
          o.contract_code ? meta('Contrato', o.contract_code) : null,
        ])
      : null,
    el('div', { class: 'flex flex-wrap text-[12px] text-ink-500 gap-x-4 gap-y-1 font-mono' }, [
      meta('A externalizar', fmtKg(o.kg_green_external_needed), { strong: true, color: 'text-warn' }),
      meta('Solicitado', fmtKg(o.kg_green_required)),
      o.kg_green_accepted != null ? meta('Aceptado', fmtKg(o.kg_green_accepted)) : null,
      meta('Entrega', fmtDate(o.max_delivery_date)),
      meta('Proceso', o.process_type),
      meta('Aspecto', o.physical_aspect),
    ]),
    // PO details strip — only when something has been set
    (o.external_po_supplier || o.external_po_code || o.external_po_date || o.external_po_notes)
      ? el('div', { class: 'mt-2 pt-2 border-t border-sand flex flex-wrap text-[12px] text-ink-500 gap-x-4 gap-y-1 font-mono' }, [
          o.external_po_supplier ? meta('Proveedor', o.external_po_supplier) : null,
          o.external_po_code     ? meta('Código PO', o.external_po_code) : null,
          o.external_po_date     ? meta('Fecha PO',  fmtDate(o.external_po_date)) : null,
        ])
      : null,
    o.external_po_notes
      ? el('p', { class: 'text-[11px] text-ink-500 italic mt-1' }, [`Notas PO: ${o.external_po_notes}`])
      : null,
    o.rejection_reason
      ? el('p', { class: 'text-[11px] text-ink-500 italic mt-2 border-t border-sand pt-2' }, [`Motivo rechazo: ${o.rejection_reason}`])
      : null,
  ]);
}

function meta(label, value, opts = {}) {
  return el('span', { class: 'inline-flex items-baseline gap-1' }, [
    el('span', { class: 'text-ink-300 uppercase tracking-loose text-[10px] font-sans font-semibold', text: label }),
    el('strong', { class: `font-mono ${opts.color || 'text-ink-700'} ${opts.strong ? 'font-bold' : ''}`, text: value }),
  ]);
}

// ──────────────────────────────────────────────────────────────────
// PO edit modal
// ──────────────────────────────────────────────────────────────────
function openPoModal(order) {
  return openModal(({ close }) => {
    const currentStatus = order.external_po_status || 'Pendiente';
    const statusSelect = el('select', { class: 'ctrm-select' },
      PO_STATUSES.map((s) => el('option', { value: s, selected: s === currentStatus }, [s])),
    );
    const supplierInput = el('input', {
      type: 'text', placeholder: 'Nombre del proveedor',
      value: order.external_po_supplier || '',
      class: 'ctrm-input',
    });
    const codeInput = el('input', {
      type: 'text', placeholder: 'Referencia / # PO',
      value: order.external_po_code || '',
      class: 'ctrm-input mono',
    });
    const dateInput = el('input', {
      type: 'date',
      value: order.external_po_date || '',
      class: 'ctrm-input',
    });
    const notesInput = el('textarea', {
      rows: '2', placeholder: 'Notas (opcional)',
      class: 'ctrm-textarea',
      value: order.external_po_notes || '',
    });

    return el('div', { class: 'space-y-3' }, [
      el('div', { class: 'rounded-lg bg-cream border border-sand p-3 text-[12px] space-y-1' }, [
        el('div', {}, [`Pedido: `, el('strong', { text: order.order_code })]),
        el('div', {}, [`Referencia: `, el('strong', { text: order.reference_name || '—' })]),
        el('div', {}, [`Cantidad a externalizar: `, el('strong', { text: fmtKg(order.kg_green_external_needed) })]),
        order.client_name ? el('div', {}, [`Cliente: `, el('strong', { text: order.client_name })]) : null,
      ]),
      labelled('Estado del PO', statusSelect),
      el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-3' }, [
        labelled('Proveedor', supplierInput),
        labelled('Código PO', codeInput),
      ]),
      labelled('Fecha del PO', dateInput),
      labelled('Notas', notesInput),
      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-primary',
          type: 'button',
          onClick: () => close({
            external_po_status:   statusSelect.value,
            external_po_supplier: supplierInput.value.trim() || null,
            external_po_code:     codeInput.value.trim() || null,
            external_po_date:     dateInput.value || null,
            external_po_notes:    notesInput.value.trim() || null,
          }),
        }, ['Guardar']),
      ]),
    ]);
  }, { title: `PO externo — ${order.order_code}`, wide: true });
}

function labelled(label, child) {
  return el('div', {}, [
    el('label', { class: 'ctrm-label', text: label }),
    child,
  ]);
}
