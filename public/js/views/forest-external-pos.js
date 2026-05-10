// "Rejection → purchase order trigger" view — CTRM-styled.
import { el } from '../ui/el.js';
import { fmtKg, fmtDate, statusLabel } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';

export async function forestExternalPosView() {
  const res = await api.ordersList({ status: 'Rejected,PartiallyAccepted,InProduction,Completed' });
  const rows = res.orders.filter((o) => Number(o.kg_green_external_needed || 0) > 0);
  const totalKg = rows.reduce((s, o) => s + Number(o.kg_green_external_needed || 0), 0);

  return chrome(el('div', {}, [
    pageTitle('Pedidos a sourcing externo', 'Rechazos y aceptaciones parciales que requieren PO con un tercero'),

    el('div', { class: 'mb-5 stat-card featured' }, [
      el('p', { class: 'stat-label', text: 'Total a buscar externamente' }),
      el('p', { class: 'stat-val', text: fmtKg(totalKg) }),
      el('p', { class: 'stat-sub', text: `${rows.length} pedido${rows.length===1?'':'s'} pendiente${rows.length===1?'':'s'}` }),
    ]),

    rows.length === 0
      ? el('p', { class: 'text-[12px] text-ink-300 italic px-1', text: 'Nada pendiente. Todos los rechazos están al día.' })
      : el('div', { class: 'space-y-2' }, rows.map(extRow)),
  ]));
}

function extRow(o) {
  const isReject = o.status === 'Rejected';
  return el('div', { class: `ctrm-card ctrm-card-pad border-l-4 ${isReject ? 'border-l-crit' : 'border-l-warn'}` }, [
    el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-2' }, [
      el('div', { class: 'flex items-center gap-2 min-w-0 flex-wrap' }, [
        el('span', { class: 'ctrm-code', text: o.order_code }),
        el('span', { class: 'font-display font-semibold text-navy text-[13px] truncate', text: o.reference_name || '—' }),
        o.order_type ? el('span', { class: 'ctrm-pill dark', text: o.order_type }) : null,
        el('span', { class: `ctrm-pill ${isReject ? 'crit' : 'warn'}`, text: statusLabel(o.status) }),
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
    o.rejection_reason ? el('p', { class: 'text-[11px] text-ink-500 italic mt-2 border-t border-sand pt-2' }, [`Motivo: ${o.rejection_reason}`]) : null,
  ]);
}

function meta(label, value, opts = {}) {
  return el('span', { class: 'inline-flex items-baseline gap-1' }, [
    el('span', { class: 'text-ink-300 uppercase tracking-loose text-[10px] font-sans font-semibold', text: label }),
    el('strong', { class: `font-mono ${opts.color || 'text-ink-700'} ${opts.strong ? 'font-bold' : ''}`, text: value }),
  ]);
}
