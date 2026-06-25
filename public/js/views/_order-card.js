// Componente unificado del pedido. Reemplaza las cards y filas de
// pedidos en /forest/dashboard y /finca/cola. Habla el mismo
// "idioma" para los dos roles — los números y pills son idénticos;
// sólo cambian las acciones disponibles.
//
// Layout:
//   ┌─ PED-XXXX · Café X · [type pill] · [info ⓘ] ────[⋮]─┐
//   │  ●─●─●─○  En producción · faltan 6 d                  │
//   │                                                       │
//   │  1.200 kg verde                  ▓▓▓▓▓░░░ 60% cubierto│
//   │  720 asignados · 480 despachados · 480 pendientes     │
//   │                                                       │
//   │  Cliente Forest US · USA · Spot · #ABC-001            │
//   │                                       [Botón primario]│
//   └───────────────────────────────────────────────────────┘

import { el } from '../ui/el.js';
import { fmtKg, fmtDate, fmtIntensity, statusLabel, statusPillKind, relDate } from '../ui/format.js';
import { actionMenu } from '../ui/action-menu.js';
import { openPopover } from '../ui/popover.js';
import { navigate } from '../router.js';

// Stepper: Pendiente · Aceptado · En producción · Cerrado
// Estados alternos: Rechazado, Cancelado (terminales)
const STEP_INDEX = {
  Pending:           0,
  Accepted:          1,
  PartiallyAccepted: 1,
  InProduction:      2,
  Completed:         3,
  // Terminales alternos: no van en el stepper, los marcamos aparte.
  Rejected:          -1,
  Cancelled:         -1,
};

const STEP_LABELS = ['Pendiente', 'Aceptado', 'En producción', 'Cerrado'];

const STATUS_COLOR = {
  Pending:           '#7e9ec1',  // sky
  Accepted:          '#5d8b66',  // forest
  PartiallyAccepted: '#ddae3e',  // mustard
  InProduction:      '#1b203d',  // navy
  Completed:         '#5d8b66',  // forest
  Rejected:          '#a8351c',  // crit
  Cancelled:         '#9aa3ae',  // ink-300
};

// Renderiza el stepper horizontal con 4 puntos. El step "activo"
// se llena con el color del status y se le pone label resaltado.
export function renderOrderStepper(o, opts = {}) {
  const status = o.status;
  const idx = STEP_INDEX[status] != null ? STEP_INDEX[status] : -1;
  const color = STATUS_COLOR[status] || '#9aa3ae';
  const compact = !!opts.compact;
  const dotSize = compact ? 8 : 10;
  const segmentH = 2;

  // Terminal alterno (Rejected, Cancelled): mostramos pill grande
  // en lugar del stepper, porque ya no aplica el flujo lineal.
  if (idx === -1) {
    return el('div', { class: 'flex items-center gap-2' }, [
      el('span', {
        class: 'inline-flex items-center gap-1.5 px-2 py-1 rounded-md font-display uppercase tracking-eyebrow text-[10px] font-semibold',
        style: `background:${color};color:#fff;`,
      }, [
        el('span', { style: 'width:6px;height:6px;background:#fff;border-radius:50%;display:inline-block;' }),
        document.createTextNode(statusLabel(status)),
      ]),
      o.cancelled_at
        ? el('span', { class: 'text-[10px] text-ink-300 font-mono',
            text: fmtDate(String(o.cancelled_at).slice(0, 10)) })
        : null,
    ]);
  }

  // Stepper normal
  const children = [];
  for (let i = 0; i < STEP_LABELS.length; i++) {
    const isPast    = i < idx;
    const isCurrent = i === idx;
    const dotColor  = isCurrent || isPast ? color : '#e8e8e2';
    const dotBorder = isCurrent ? color : 'transparent';
    children.push(el('div', { class: 'flex flex-col items-center' }, [
      el('div', {
        style: `width:${dotSize}px;height:${dotSize}px;border-radius:50%;background:${dotColor};box-shadow:0 0 0 ${isCurrent ? 2 : 0}px ${dotBorder};`,
      }),
      compact ? null : el('span', {
        class: `font-display uppercase tracking-eyebrow text-[8.5px] mt-1 ${isCurrent ? 'font-bold' : 'text-ink-300'}`,
        style: isCurrent ? `color:${color};` : '',
        text: STEP_LABELS[i],
      }),
    ]));
    if (i < STEP_LABELS.length - 1) {
      const lineColor = i < idx ? color : '#e8e8e2';
      children.push(el('div', {
        style: `flex:1;height:${segmentH}px;background:${lineColor};margin:0 4px;`,
        class: compact ? 'min-w-[12px]' : 'min-w-[20px] mt-[3px] self-start',
      }));
    }
  }
  return el('div', { class: 'flex items-start' }, children);
}

// Calcula la acción primaria visible en la card según rol + status.
// Devuelve { label, onClick, kind } o null si solo va el kebab.
function primaryActionFor(o, role, callbacks) {
  const cb = callbacks || {};
  if (role === 'finca' || role === 'admin') {
    if (o.status === 'Pending') {
      return { label: 'Aceptar pedido', kind: 'action',
        onClick: cb.onAccept || (() => navigate('/finca/inbox')) };
    }
    if (o.status === 'Accepted' || o.status === 'PartiallyAccepted' || o.status === 'InProduction') {
      const pending = Number(o.pending_kg != null ? o.pending_kg : 0);
      if (pending > 0.01) {
        return { label: 'Asignar lote', kind: 'action',
          onClick: cb.onAssign || (() => navigate('/finca/lots')) };
      }
    }
  }
  // Default: solo abrir detalle
  return { label: 'Ver detalle', kind: 'ghost',
    onClick: cb.onView || (() => navigate(`/pedido?id=${o.id}`)) };
}

// Botón "ⓘ" con popover (mismo que cola actualmente). Muestra los
// datos de la solicitud original (cliente, aspecto, intensidad,
// comentario de Forest). Lo dejamos aquí compartido.
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

// Card compacta unificada. opts: { role, rollup, callbacks, secondaryActions }
//   rollup: { assigned_kg, shipped_kg, pending_kg }  (compu por el caller)
//   callbacks: { onAccept, onAssign, onView, onClose, onEdit, onCancel }
//   secondaryActions: [{ label, onClick, danger }] (entran en el kebab)
export function renderOrderCard(o, opts = {}) {
  const role = opts.role || 'finca';
  const rollup = opts.rollup || {};
  const callbacks = opts.callbacks || {};
  const secondary = (opts.secondaryActions || []).filter(Boolean);

  const accepted = Number(o.kg_green_accepted || 0);
  const required = Number(o.kg_green_required || 0);
  const primaryKg = accepted || required;
  const primaryLabel = accepted > 0 ? 'kg verde aceptado' : 'kg verde requerido';
  const assigned = Number(rollup.assigned_kg != null ? rollup.assigned_kg : 0);
  const shipped = Number(rollup.shipped_kg != null ? rollup.shipped_kg : 0);
  const pending = Number(rollup.pending_kg != null ? rollup.pending_kg : Math.max(0, accepted - assigned));
  const coverPct = primaryKg > 0 ? Math.min(100, (assigned / primaryKg) * 100) : 0;

  const primary = primaryActionFor({ ...o, pending_kg: pending }, role, callbacks);
  const kebab = actionMenu(secondary);

  // Stripe lateral del color del status para reconocer el estado
  // de un vistazo aún en lista densa.
  const stripeColor = STATUS_COLOR[o.status] || '#9aa3ae';

  return el('div', {
    class: 'ctrm-card overflow-hidden relative',
    'data-order-id': o.id,
  }, [
    el('div', { style: `position:absolute;top:0;left:0;bottom:0;width:3px;background:${stripeColor};` }),
    el('div', { class: 'p-3 pl-4 space-y-2.5' }, [
      // Línea 1: código + ref + info + kebab
      el('div', { class: 'flex items-center justify-between gap-2 flex-wrap' }, [
        el('div', { class: 'flex items-center gap-2 flex-wrap min-w-0' }, [
          el('button', {
            type: 'button',
            class: 'ctrm-code hover:underline shrink-0',
            style: 'background:none;border:none;padding:2px 6px;cursor:pointer;',
            onClick: () => navigate(`/pedido?id=${o.id}`),
            text: o.order_code || '—',
          }),
          el('span', { class: 'font-display font-semibold text-navy text-[13px] truncate', text: o.reference_name || '—' }),
          o.order_type ? el('span', { class: 'ctrm-pill dark text-[10px]', text: o.order_type }) : null,
          requestInfoButton(o),
        ]),
        kebab,
      ]),

      // Línea 2: stepper + status hint
      el('div', { class: 'flex items-center justify-between gap-3' }, [
        el('div', { class: 'flex-1 max-w-[280px]' }, [renderOrderStepper(o)]),
        el('p', { class: 'text-[11px] text-ink-500 font-mono shrink-0' }, [
          urgencyHint(o),
        ]),
      ]),

      // Línea 3: métrica primaria + cobertura
      el('div', { class: 'flex items-baseline justify-between gap-4 flex-wrap' }, [
        el('div', {}, [
          el('p', { class: 'font-display font-semibold text-navy text-[20px] leading-tight',
            text: fmtKg(primaryKg) }),
          el('p', { class: 'text-[10px] text-ink-500 uppercase tracking-eyebrow font-semibold',
            text: primaryLabel }),
        ]),
        el('div', { class: 'flex-1 min-w-[140px] max-w-[280px]' }, [
          el('div', { class: 'flex items-baseline justify-between text-[11px] text-ink-500 mb-1' }, [
            el('span', { text: 'Cobertura' }),
            el('strong', { class: 'font-mono text-ink-700', text: `${Math.round(coverPct)}%` }),
          ]),
          el('div', { class: 'h-1.5 rounded-full bg-sand overflow-hidden' }, [
            el('div', { class: 'h-full', style: `width:${coverPct}%;background:${stripeColor};` }),
          ]),
          el('p', { class: 'text-[10px] font-mono text-ink-500 mt-0.5 truncate' }, [
            `${fmtKg(assigned)} asignados · ${fmtKg(shipped)} despachados · ${fmtKg(pending)} pendientes`,
          ]),
        ]),
      ]),

      // Línea 4: client / regions / contract / entrega
      el('p', { class: 'text-[11px] text-ink-500 font-mono flex flex-wrap gap-x-3 gap-y-0.5' }, [
        o.client_name ? el('span', {}, [
          el('span', { class: 'text-ink-300', text: 'Cliente ' }),
          el('strong', { class: 'text-ink-700', text: o.client_name }),
        ]) : null,
        (o.regions && o.regions.length) ? el('span', {}, [
          el('span', { class: 'text-ink-300', text: 'Región ' }),
          el('strong', { class: 'text-ink-700', text: o.regions.join('·') }),
        ]) : null,
        o.contract_code ? el('span', {}, [
          el('span', { class: 'text-ink-300', text: 'Contrato ' }),
          el('strong', { class: 'text-ink-700', text: o.contract_code }),
        ]) : null,
        o.max_delivery_date ? el('span', {}, [
          el('span', { class: 'text-ink-300', text: 'Entrega ' }),
          el('strong', { class: 'text-ink-700', text: fmtDate(o.max_delivery_date) }),
        ]) : null,
      ]),

      // Línea 5: acción primaria (solo si hay una significativa)
      primary && primary.kind !== 'ghost'
        ? el('div', { class: 'flex justify-end pt-1' }, [
            el('button', {
              type: 'button',
              class: `ctrm-btn ctrm-btn-sm ${primary.kind === 'action' ? 'ctrm-btn-action' : 'ctrm-btn-soft'}`,
              onClick: primary.onClick,
            }, [primary.label]),
          ])
        : null,
    ]),
  ]);
}

// Devuelve el "hint" pequeño a la derecha del stepper. Usa el
// drying_urgency / delivery_urgency que ya calculan los endpoints.
function urgencyHint(o) {
  const status = o.status;
  if (status === 'Completed' && o.completed_at) {
    return `Cerrado ${relDate(String(o.completed_at).slice(0, 10))}`;
  }
  if (status === 'Cancelled' && o.cancelled_at) {
    return `Cancelado ${relDate(String(o.cancelled_at).slice(0, 10))}`;
  }
  if (status === 'Rejected') return 'Rechazado';
  if (o.max_delivery_date) {
    return `Entrega ${relDate(o.max_delivery_date)}`;
  }
  return statusLabel(status);
}

// Para la vista TABLA: devuelve un array de celdas para sortable-table.
// El caller decide cómo armar el <tr>. Pensado como helper paralelo a
// renderOrderCard cuando el modo de vista es 'table'.
export function orderTableCells(o, opts = {}) {
  const role = opts.role || 'finca';
  const rollup = opts.rollup || {};
  const accepted = Number(o.kg_green_accepted || 0);
  const required = Number(o.kg_green_required || 0);
  const primaryKg = accepted || required;
  const assigned = Number(rollup.assigned_kg != null ? rollup.assigned_kg : 0);
  const shipped = Number(rollup.shipped_kg != null ? rollup.shipped_kg : 0);
  const pending = Number(rollup.pending_kg != null ? rollup.pending_kg : Math.max(0, accepted - assigned));
  const coverPct = primaryKg > 0 ? Math.round((assigned / primaryKg) * 100) : 0;
  const stripeColor = STATUS_COLOR[o.status] || '#9aa3ae';
  const callbacks = opts.callbacks || {};
  const primary = primaryActionFor({ ...o, pending_kg: pending }, role, callbacks);
  const secondary = (opts.secondaryActions || []).filter(Boolean);

  return {
    codeNode: el('button', {
      type: 'button',
      class: 'font-mono text-navy font-semibold hover:underline',
      style: 'background:none;border:none;padding:0;cursor:pointer;',
      onClick: (e) => { e.stopPropagation(); navigate(`/pedido?id=${o.id}`); },
      text: o.order_code || '—',
    }),
    refNode: el('span', { class: 'text-ink-700 text-[12px]', text: o.reference_name || '—' }),
    stepperNode: el('div', { class: 'min-w-[110px]' }, [renderOrderStepper(o, { compact: true })]),
    kgNode: el('span', { class: 'font-mono', text: fmtKg(primaryKg) }),
    coverageNode: el('div', { class: 'flex items-center gap-2 min-w-[100px]' }, [
      el('span', { class: 'font-mono text-[11px]', text: `${coverPct}%` }),
      el('div', { class: 'flex-1 h-1.5 rounded-full bg-sand overflow-hidden min-w-[40px]' }, [
        el('div', { class: 'h-full', style: `width:${coverPct}%;background:${stripeColor};` }),
      ]),
    ]),
    pendingNode: el('span', { class: 'font-mono', text: fmtKg(pending) }),
    shippedNode: el('span', { class: 'font-mono', text: fmtKg(shipped) }),
    clientNode: el('span', { class: 'text-[12px]', text: o.client_name || '—' }),
    deliveryNode: el('span', { class: 'font-mono text-[11px]',
      text: o.max_delivery_date ? `${fmtDate(o.max_delivery_date)} · ${relDate(o.max_delivery_date)}` : '—' }),
    actionsNode: el('div', { class: 'inline-flex items-center gap-1' }, [
      primary && primary.kind !== 'ghost' ? el('button', {
        type: 'button',
        class: `ctrm-btn ctrm-btn-xs ${primary.kind === 'action' ? 'ctrm-btn-action' : 'ctrm-btn-soft'}`,
        onClick: (e) => { e.stopPropagation(); primary.onClick(); },
      }, [primary.label]) : null,
      actionMenu(secondary),
    ]),
  };
}
