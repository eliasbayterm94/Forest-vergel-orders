// Finca incoming-demand inbox — CTRM-styled.
import { el, clear } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { openModal, confirmModal } from '../ui/modal.js';
import { fmtKg, fmtDate, statusLabel, statusPillKind, URGENCY_LABEL } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { renderCapacityPayload } from './_capacity-panel.js';

export async function fincaInboxView() {
  let orders = [];
  const selected = new Set();
  let lastFetchedSelection = '';

  const ordersWrap   = el('div', { class: 'space-y-2' });
  const previewWrap  = el('div', {
    class: 'ctrm-card ctrm-card-pad lg:sticky lg:top-4 lg:self-start',
  });

  await refresh();

  return chrome(el('div', {}, [
    pageTitle('Pedidos entrantes', 'Acepta o rechaza. Marca para previsualizar capacidad.'),
    el('div', { class: 'grid grid-cols-1 lg:grid-cols-3 gap-4' }, [
      el('div', { class: 'lg:col-span-2 space-y-3' }, [
        el('div', { class: 'flex items-center justify-between' }, [
          el('p', { class: 'eyebrow', id: 'pending-count' }, []),
          el('button', {
            class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
            onClick: async () => { selected.clear(); await refresh(); },
          }, ['Limpiar selección']),
        ]),
        ordersWrap,
      ]),
      el('div', { class: 'lg:col-span-1' }, [
        el('h3', { class: 'eyebrow mb-2', text: 'Vista de capacidad' }),
        previewWrap,
      ]),
    ]),
  ]));

  async function refresh() {
    try {
      const res = await api.ordersList({ status: 'Pending' });
      orders = res.orders;
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
    if (countEl) countEl.textContent = `${orders.length} pendiente${orders.length===1?'':'s'}`;

    if (orders.length === 0) {
      ordersWrap.append(el('p', { class: 'text-[12px] text-ink-300 italic px-1', text: 'Sin pedidos pendientes.' }));
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
      class: 'mt-1 h-4 w-4 accent-navy',
      checked,
      onChange: async (e) => {
        if (e.target.checked) selected.add(o.id);
        else selected.delete(o.id);
        await refreshPreview();
      },
    });

    const dryingBadge = el('span', { class: `ctrm-pill urgency-${o.drying_urgency || 'normal'}`,
      text: URGENCY_LABEL[o.drying_urgency] || o.drying_urgency || '',
    });

    return el('div', { class: 'ctrm-card ctrm-card-pad' }, [
      el('div', { class: 'flex items-start gap-3' }, [
        cb,
        el('div', { class: 'flex-1 min-w-0' }, [
          el('div', { class: 'flex flex-wrap items-center gap-2 mb-2' }, [
            el('span', { class: 'ctrm-code', text: o.order_code }),
            el('span', { class: 'font-display font-semibold text-navy text-[13px]', text: o.reference_name || '—' }),
            el('span', { class: `ctrm-pill ${statusPillKind(o.status)}`, text: statusLabel(o.status) }),
            dryingBadge,
          ]),
          el('div', { class: 'flex flex-wrap text-[12px] text-ink-500 gap-x-4 gap-y-1 font-mono' }, [
            meta('Verde', fmtKg(o.kg_green_required)),
            meta('Cereza', fmtKg(o.kg_cherry_required)),
            meta('Entrega', fmtDate(o.max_delivery_date)),
            meta('Inicio drying', fmtDate(o.latest_drying_start_date)),
            meta('Proceso', o.process_type),
            meta('Aspecto', o.physical_aspect),
            o.fermentation_hours != null ? meta('Ferm', `${o.fermentation_hours} h`) : null,
          ]),
          (o.varieties || []).length > 0
            ? el('div', { class: 'flex flex-wrap gap-1 mt-2' }, (o.varieties || []).map((v) =>
                el('span', { class: 'ctrm-pill dark', text: v.name }),
              ))
            : null,
          o.comments ? el('p', { class: 'text-[11px] text-ink-500 italic mt-2 border-t border-sand pt-2' }, [o.comments]) : null,
          el('div', { class: 'flex flex-wrap gap-2 mt-3' }, [
            el('button', {
              class: 'ctrm-btn ctrm-btn-primary ctrm-btn-sm',
              onClick: () => openAcceptFlow(o),
            }, ['Aceptar']),
            el('button', {
              class: 'ctrm-btn ctrm-btn-danger ctrm-btn-sm',
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
      previewWrap.append(el('p', { class: 'text-[12px] text-ink-300 italic', text: 'Marca uno o más pedidos para ver la capacidad.' }));
      lastFetchedSelection = '';
      return;
    }
    if (sig === lastFetchedSelection) return;
    previewWrap.append(skeleton());
    try {
      const payload = await api.capacity({ order_ids: ids, include_active_queue: true });
      lastFetchedSelection = sig;
      clear(previewWrap);
      previewWrap.append(renderCapacityPayload(payload, { showOrders: true }));
    } catch (e) {
      clear(previewWrap);
      previewWrap.append(el('p', { class: 'text-[12px] text-crit', text: e.message }));
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

function meta(label, value) {
  return el('span', { class: 'inline-flex items-baseline gap-1' }, [
    el('span', { class: 'text-ink-300 uppercase tracking-loose text-[10px] font-sans font-semibold', text: label }),
    el('strong', { class: 'text-ink-700 font-mono', text: value }),
  ]);
}

function acceptModalBody(order, close) {
  let mode = 'full';

  const summary = el('div', { class: 'rounded-lg bg-cream border border-sand p-3 text-[12px] space-y-1 font-mono' }, [
    summaryLine('Referencia', order.reference_name || '—'),
    summaryLine('Solicitado', `${fmtKg(order.kg_green_required)} verde`),
    summaryLine('Cereza', fmtKg(order.kg_cherry_required)),
    summaryLine('Entrega', fmtDate(order.max_delivery_date)),
    summaryLine('Inicio drying', fmtDate(order.latest_drying_start_date)),
  ]);

  const kgInput = el('input', {
    type: 'number', step: '0.01', min: '0', max: String(order.kg_green_required),
    value: String(order.kg_green_required),
    class: 'ctrm-input mono',
  });
  const remainder = el('p', { class: 'ctrm-hint' });
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
    el('label', { class: 'ctrm-label', text: 'kg verde a aceptar' }),
    kgInput,
    remainder,
  ]);

  const fullBtn = el('button', { type: 'button', class: 'ctrm-btn ctrm-btn-primary flex-1 uppercase tracking-eyebrow text-[10px]' }, ['Total']);
  const partBtn = el('button', { type: 'button', class: 'ctrm-btn ctrm-btn-soft flex-1 uppercase tracking-eyebrow text-[10px]' }, ['Parcial']);
  function setMode(m) {
    mode = m;
    fullBtn.className = `ctrm-btn flex-1 uppercase tracking-eyebrow text-[10px] ${m === 'full' ? 'ctrm-btn-primary' : 'ctrm-btn-soft'}`;
    partBtn.className = `ctrm-btn flex-1 uppercase tracking-eyebrow text-[10px] ${m === 'partial' ? 'ctrm-btn-primary' : 'ctrm-btn-soft'}`;
    partialRow.hidden = m !== 'partial';
  }
  fullBtn.addEventListener('click', () => setMode('full'));
  partBtn.addEventListener('click', () => setMode('partial'));

  return el('div', { class: 'space-y-3' }, [
    summary,
    el('div', { class: 'flex gap-2' }, [fullBtn, partBtn]),
    partialRow,
    el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
      el('button', {
        class: 'ctrm-btn ctrm-btn-ghost',
        type: 'button', onClick: () => close(null),
      }, ['Cancelar']),
      el('button', {
        class: 'ctrm-btn ctrm-btn-primary',
        type: 'button',
        onClick: () => {
          let value;
          if (mode === 'full') value = Number(order.kg_green_required);
          else {
            value = Number(kgInput.value || 0);
            if (!(value > 0)) { toast('Cantidad inválida', 'warning'); return; }
            if (value > Number(order.kg_green_required)) { toast('Excede lo solicitado', 'warning'); return; }
          }
          close({ kg: value });
        },
      }, ['Confirmar aceptación']),
    ]),
  ]);
}

function rejectModalBody(order, close) {
  const summary = el('div', { class: 'rounded-lg bg-cream border border-sand p-3 text-[12px] space-y-1 font-mono' }, [
    summaryLine('Referencia', order.reference_name || '—'),
    summaryLine('Solicitado', `${fmtKg(order.kg_green_required)} verde`),
  ]);
  const reasonInput = el('textarea', {
    rows: '3', placeholder: 'Motivo (opcional pero recomendado)',
    class: 'ctrm-textarea',
  });
  return el('div', { class: 'space-y-3' }, [
    summary,
    el('label', { class: 'ctrm-label', text: 'Motivo' }),
    reasonInput,
    el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
      el('button', {
        class: 'ctrm-btn ctrm-btn-ghost',
        type: 'button', onClick: () => close(null),
      }, ['Cancelar']),
      el('button', {
        class: 'ctrm-btn ctrm-btn-danger',
        type: 'button',
        onClick: () => close({ reason: reasonInput.value.trim() }),
      }, ['Rechazar pedido']),
    ]),
  ]);
}

function summaryLine(label, value) {
  return el('div', { class: 'flex justify-between' }, [
    el('span', { class: 'text-ink-500 uppercase tracking-loose text-[10px]', text: label }),
    el('strong', { class: 'text-navy', text: value }),
  ]);
}
