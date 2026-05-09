// Finca incoming-demand inbox.
// Left pane: pending orders with checkbox + per-row Aceptar / Rechazar.
// Right pane (sticky desktop / below on mobile): live capacity preview.
import { el, clear } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { openModal, confirmModal } from '../ui/modal.js';
import { fmtKg, fmtDate, statusLabel, URGENCY_LABEL } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { renderCapacityPayload } from './_capacity-panel.js';

export async function fincaInboxView() {
  let orders = [];
  const selected = new Set();        // demand_order ids
  let lastFetchedSelection = '';     // to dedupe capacity calls

  const ordersWrap   = el('div', { class: 'space-y-2' });
  const previewWrap  = el('div', {
    class: 'bg-white rounded-xl border border-slate-200 p-3 sm:p-4 lg:sticky lg:top-4 lg:self-start',
  });

  await refresh();

  return chrome(el('div', {}, [
    pageTitle('Pedidos entrantes', 'Acepta o rechaza. Marca para previsualizar capacidad.'),
    el('div', { class: 'grid grid-cols-1 lg:grid-cols-3 gap-4' }, [
      el('div', { class: 'lg:col-span-2 space-y-2' }, [
        el('div', { class: 'flex items-center justify-between' }, [
          el('p', { class: 'text-xs text-slate-500', id: 'pending-count' }, []),
          el('button', {
            class: 'text-xs px-3 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700',
            onClick: async () => { selected.clear(); await refresh(); },
          }, ['Limpiar selección']),
        ]),
        ordersWrap,
      ]),
      el('div', { class: 'lg:col-span-1' }, [
        el('h3', { class: 'text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2', text: 'Vista de capacidad' }),
        previewWrap,
      ]),
    ]),
  ]));

  async function refresh() {
    try {
      const res = await api.ordersList({ status: 'Pending' });
      orders = res.orders;
      // Drop selection IDs that are no longer pending
      for (const id of [...selected]) {
        if (!orders.some((o) => o.id === id)) selected.delete(id);
      }
      renderOrders();
      await refreshPreview();
    } catch (e) { toast(e.message, 'error'); }
  }

  function renderOrders() {
    clear(ordersWrap);
    const countEl = document.getElementById('pending-count');
    if (countEl) countEl.textContent = `${orders.length} pendiente(s)`;

    if (orders.length === 0) {
      ordersWrap.append(el('p', { class: 'text-sm text-slate-400 italic px-1', text: 'Sin pedidos pendientes.' }));
      return;
    }

    for (const o of orders) {
      ordersWrap.append(orderRow(o));
    }
  }

  function orderRow(o) {
    const checked = selected.has(o.id);
    const cb = el('input', {
      type: 'checkbox',
      class: 'mt-1 h-4 w-4 rounded text-forest focus:ring-forest',
      checked,
      onChange: async (e) => {
        if (e.target.checked) selected.add(o.id);
        else selected.delete(o.id);
        await refreshPreview();
      },
    });

    const dryingBadge = el('span', { class: `text-[11px] px-1.5 py-0.5 rounded urgency-${o.drying_urgency || 'normal'}`,
      text: URGENCY_LABEL[o.drying_urgency] || o.drying_urgency || '',
    });

    return el('div', { class: 'bg-white rounded-xl border border-slate-200 p-3 sm:p-4' }, [
      el('div', { class: 'flex items-start gap-3' }, [
        cb,
        el('div', { class: 'flex-1 min-w-0' }, [
          el('div', { class: 'flex flex-wrap items-center gap-2 mb-1' }, [
            el('span', { class: 'font-mono text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700', text: o.order_code }),
            el('span', { class: 'font-medium text-slate-900', text: o.reference_name || '—' }),
            el('span', { class: 'text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600', text: statusLabel(o.status) }),
            dryingBadge,
          ]),
          el('div', { class: 'flex flex-wrap text-xs text-slate-600 gap-x-4 gap-y-1' }, [
            el('span', {}, [`Verde: `, el('strong', { text: fmtKg(o.kg_green_required) })]),
            el('span', {}, [`Cereza: `, el('strong', { text: fmtKg(o.kg_cherry_required) })]),
            el('span', {}, [`Entrega: `, el('strong', { text: fmtDate(o.max_delivery_date) })]),
            el('span', {}, [`Inicio drying: `, el('strong', { text: fmtDate(o.latest_drying_start_date) })]),
            el('span', {}, [`Proceso: `, el('strong', { text: o.process_type })]),
            el('span', {}, [`Aspecto: `, el('strong', { text: o.physical_aspect })]),
            o.fermentation_hours != null ? el('span', {}, [`Ferm: `, el('strong', { text: `${o.fermentation_hours} h` })]) : null,
          ]),
          (o.varieties || []).length > 0
            ? el('div', { class: 'flex flex-wrap gap-1 text-[11px] mt-1' }, (o.varieties || []).map((v) =>
                el('span', { class: 'px-2 py-0.5 rounded-full bg-forest-light/15 text-forest-dark', text: v.name }),
              ))
            : null,
          o.comments ? el('p', { class: 'text-xs text-slate-500 italic mt-1', text: o.comments }) : null,
          el('div', { class: 'flex flex-wrap gap-2 mt-3' }, [
            el('button', {
              class: 'px-3 py-1.5 rounded-lg bg-forest hover:bg-forest-dark text-white text-sm',
              onClick: () => openAcceptFlow(o),
            }, ['Aceptar']),
            el('button', {
              class: 'px-3 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 text-sm border border-rose-200',
              onClick: () => openRejectFlow(o),
            }, ['Rechazar']),
          ]),
        ]),
      ]),
    ]);
  }

  async function refreshPreview() {
    clear(previewWrap);
    const ids = [...selected];
    const sig = ids.slice().sort().join(',');
    if (ids.length === 0) {
      previewWrap.append(el('p', { class: 'text-sm text-slate-400 italic', text: 'Marca uno o más pedidos para ver la capacidad.' }));
      lastFetchedSelection = '';
      return;
    }
    if (sig === lastFetchedSelection) return; // de-dupe
    previewWrap.append(skeleton());
    try {
      const payload = await api.capacity({ order_ids: ids, include_active_queue: true });
      lastFetchedSelection = sig;
      clear(previewWrap);
      previewWrap.append(renderCapacityPayload(payload, { showOrders: true }));
    } catch (e) {
      clear(previewWrap);
      previewWrap.append(el('p', { class: 'text-sm text-rose-700', text: e.message }));
    }
  }

  function skeleton() {
    return el('div', { class: 'space-y-2' }, [
      el('div', { class: 'h-5 skeleton rounded' }),
      el('div', { class: 'h-16 skeleton rounded' }),
      el('div', { class: 'h-32 skeleton rounded' }),
    ]);
  }

  // ---------- Accept / Reject flows ----------
  async function openAcceptFlow(order) {
    const result = await openModal(({ close }) => acceptModalBody(order, close), {
      title: `Aceptar ${order.order_code}`, wide: true,
    });
    if (!result) return;
    try {
      await api.orderAccept({ order_id: order.id, kg_green_accepted: result.kg });
      toast(`Pedido ${order.order_code} aceptado`, 'success');
      await refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function openRejectFlow(order) {
    const result = await openModal(({ close }) => rejectModalBody(order, close), {
      title: `Rechazar ${order.order_code}`,
    });
    if (!result) return;
    const ok = await confirmModal('¿Confirmas el rechazo? Forest deberá buscar el lote externamente.', {
      title: 'Confirmar rechazo', confirmText: 'Rechazar', danger: true,
    });
    if (!ok) return;
    try {
      await api.orderReject({ order_id: order.id, rejection_reason: result.reason || null });
      toast(`Pedido ${order.order_code} rechazado`, 'success');
      await refresh();
    } catch (e) { toast(e.message, 'error'); }
  }
}

function acceptModalBody(order, close) {
  let mode = 'full';
  let kg = Number(order.kg_green_required);

  const summary = el('div', { class: 'rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm space-y-1' }, [
    el('div', {}, [`Referencia: `, el('strong', { text: order.reference_name || '—' })]),
    el('div', {}, [`Solicitado: `, el('strong', { text: fmtKg(order.kg_green_required) }), ' verde']),
    el('div', {}, [`Cereza requerida: `, el('strong', { text: fmtKg(order.kg_cherry_required) })]),
    el('div', {}, [`Entrega: `, el('strong', { text: fmtDate(order.max_delivery_date) })]),
    el('div', {}, [`Inicio drying: `, el('strong', { text: fmtDate(order.latest_drying_start_date) })]),
  ]);

  const kgInput = el('input', {
    type: 'number', step: '0.01', min: '0', max: String(order.kg_green_required),
    value: String(order.kg_green_required),
    class: 'w-full px-3 py-2 rounded-lg border border-slate-300',
  });
  const remainder = el('p', { class: 'text-xs text-slate-500' });
  const updateRemainder = () => {
    const accepted = Number(kgInput.value || 0);
    const ext = Math.max(0, Number(order.kg_green_required) - accepted);
    remainder.textContent = ext > 0
      ? `Resto a sourcing externo: ${fmtKg(ext)}`
      : 'Aceptación total — sin resto externo.';
  };
  kgInput.addEventListener('input', updateRemainder);
  updateRemainder();
  const partialRow = el('div', { class: 'space-y-1', hidden: true }, [
    el('label', { class: 'block text-sm font-medium text-slate-700', text: 'kg verde a aceptar' }),
    kgInput,
    remainder,
  ]);

  const fullBtn = el('button', { type: 'button', class: 'flex-1 px-3 py-2 rounded-lg bg-forest text-white' }, ['Total']);
  const partBtn = el('button', { type: 'button', class: 'flex-1 px-3 py-2 rounded-lg bg-slate-100 text-slate-700' }, ['Parcial']);
  function setMode(m) {
    mode = m;
    fullBtn.className = `flex-1 px-3 py-2 rounded-lg ${m === 'full' ? 'bg-forest text-white' : 'bg-slate-100 text-slate-700'}`;
    partBtn.className = `flex-1 px-3 py-2 rounded-lg ${m === 'partial' ? 'bg-forest text-white' : 'bg-slate-100 text-slate-700'}`;
    partialRow.hidden = m !== 'partial';
  }
  fullBtn.addEventListener('click', () => setMode('full'));
  partBtn.addEventListener('click', () => setMode('partial'));

  return el('div', { class: 'space-y-3' }, [
    summary,
    el('div', { class: 'flex gap-2' }, [fullBtn, partBtn]),
    partialRow,
    el('div', { class: 'flex justify-end gap-2 pt-2' }, [
      el('button', {
        class: 'px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700',
        type: 'button', onClick: () => close(null),
      }, ['Cancelar']),
      el('button', {
        class: 'px-4 py-2 rounded-lg bg-forest hover:bg-forest-dark text-white',
        type: 'button',
        onClick: () => {
          let value;
          if (mode === 'full') value = Number(order.kg_green_required);
          else {
            value = Number(kgInput.value || 0);
            if (!(value > 0)) { toast('Cantidad inválida', 'warning'); return; }
            if (value > Number(order.kg_green_required)) { toast('Excede lo solicitado', 'warning'); return; }
            if (value === Number(order.kg_green_required)) { /* OK — counts as full */ }
          }
          close({ kg: value });
        },
      }, ['Confirmar aceptación']),
    ]),
  ]);
}

function rejectModalBody(order, close) {
  const summary = el('div', { class: 'rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm space-y-1' }, [
    el('div', {}, [`Referencia: `, el('strong', { text: order.reference_name || '—' })]),
    el('div', {}, [`Solicitado: `, el('strong', { text: fmtKg(order.kg_green_required) }), ' verde']),
  ]);
  const reasonInput = el('textarea', {
    rows: '3', placeholder: 'Motivo (opcional pero recomendado)',
    class: 'w-full px-3 py-2 rounded-lg border border-slate-300',
  });
  return el('div', { class: 'space-y-3' }, [
    summary,
    el('label', { class: 'block text-sm font-medium text-slate-700', text: 'Motivo' }),
    reasonInput,
    el('div', { class: 'flex justify-end gap-2 pt-2' }, [
      el('button', {
        class: 'px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700',
        type: 'button', onClick: () => close(null),
      }, ['Cancelar']),
      el('button', {
        class: 'px-4 py-2 rounded-lg bg-rose-700 hover:bg-rose-800 text-white',
        type: 'button',
        onClick: () => close({ reason: reasonInput.value.trim() }),
      }, ['Rechazar pedido']),
    ]),
  ]);
}
