import { el } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { openModal, confirmModal } from '../ui/modal.js';
import { createCombobox, createMultiCombobox } from '../ui/combobox.js';
import { fmtKg, fmtDate, statusLabel, statusPillKind, URGENCY_LABEL } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { navigate } from '../router.js';

const PHYSICAL_ASPECTS = ['Verde', 'Verde amarillo', 'Amarillo', 'Amarillo-Marrón', 'Parduzco'];
const PROCESS_TYPES    = ['Natural', 'Honey', 'Lavado'];
const ORDER_TYPES      = ['Spot', 'Contract', 'FOB'];
const REGIONS          = ['USA', 'EU', 'UK', 'MENA', 'AU'];

export async function forestDashboardView() {
  const [ordersRes, lotsRes, refsRes, varsRes] = await Promise.all([
    api.ordersList({}),
    api.lotsList({ status: 'Ready' }),
    api.references(),
    api.varieties(),
  ]);
  const today = ordersRes.today;
  const orders = ordersRes.orders;
  const readyLots = lotsRes.lots;
  const allReferences = refsRes.references;
  const allVarieties  = varsRes.varieties;

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
  const rowFor = (o) => orderRow(o, {
    actions: o.status === 'Pending' ? [
      { label: 'Editar',  variant: 'soft',   onClick: () => openEditOrder(o) },
      { label: 'Cancelar', variant: 'danger', onClick: () => openCancelOrder(o) },
    ] : null,
  });

  return chrome(el('div', {}, [
    pageTitle('Tablero Forest', `Hoy: ${today}`),

    statRow([
      stat('Pendientes',  buckets.pending.length,  'Esperando finca'),
      stat('En curso',    buckets.inFlight.length, 'Aceptados / producción'),
      stat('Listos',      readyLots.length,        'Lotes para envío', { kind: 'ok' }),
      stat('Externos',    buckets.rejected.length + buckets.partial.length, 'Requieren PO', { kind: buckets.rejected.length + buckets.partial.length > 0 ? 'crit' : 'ok' }),
    ]),

    primaryCTA(),

    section('Urgencias',
      urgencies.length === 0 ? emptyText('Sin urgencias.') : urgencies.map(rowFor),
    ),

    section('Lotes listos para envío',
      readyLots.length === 0 ? emptyText('Ninguno por ahora.') : readyLots.map(lotRow),
    ),

    section('Pedidos en curso',
      buckets.inFlight.length === 0 ? emptyText('Sin pedidos activos.') : buckets.inFlight.map(rowFor),
    ),

    section('Pedidos pendientes (esperando finca)',
      buckets.pending.length === 0 ? emptyText('Sin pendientes.') : buckets.pending.map(rowFor),
    ),
  ]));

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

function primaryCTA() {
  return el('div', { class: 'mb-5' }, [
    el('button', {
      class: 'ctrm-btn ctrm-btn-yellow w-full sm:w-auto uppercase tracking-eyebrow text-[11px] py-3 px-6',
      onClick: () => navigate('/forest/demand'),
    }, ['+ Nuevo pedido']),
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
      meta('Cereza', fmtKg(o.kg_cherry_required)),
      meta('Entrega', fmtDate(o.max_delivery_date)),
      meta('Drying-start', fmtDate(o.latest_drying_start_date)),
      meta('Proceso', o.process_type),
    ]),
    actionButtons.length > 0
      ? el('div', { class: 'flex gap-2 mt-3 pt-2 border-t border-sand' }, actionButtons)
      : null,
  ]);
}

function lotRow(l) {
  return el('div', { class: 'ctrm-card ctrm-card-pad' }, [
    el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-2' }, [
      el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
        el('span', { class: 'ctrm-code', text: l.lot_code }),
        el('span', { class: 'font-display font-semibold text-navy text-[13px]', text: l.reference_name || '—' }),
        el('span', { class: 'ctrm-pill ok', text: statusLabel(l.status) }),
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
        el('div', { class: 'mt-3' }, [labelled('Código de contrato', contractInput)]),
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
