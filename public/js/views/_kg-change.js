// Ajuste de cantidad de un pedido, con aprobación de la finca.
// Ver migración 0050 para el modelo.
//
// Forest pide un delta (+ añadir / − quitar); El Vergel lo acepta o lo
// rechaza. Mientras está pendiente, kg_green_required y
// kg_green_accepted no se mueven, así que producción sigue trabajando
// contra el compromiso vigente.

import { el } from '../ui/el.js';
import { openModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { fmtKg, fmtDate } from '../ui/format.js';

function row(label, value, extraCls = '') {
  return el('div', { class: 'flex items-baseline justify-between gap-3 text-[12px]' }, [
    el('span', { class: 'text-ink-500', text: label }),
    el('strong', { class: `font-mono text-ink-700 ${extraCls}`, text: value }),
  ]);
}

/**
 * Modal de Forest para pedir el ajuste.
 * Resuelve { delta_kg, reason } o null si se cancela.
 */
export function openAdjustKgModal(order) {
  return openModal(({ close }) => {
    const required = Number(order.kg_green_required || 0);
    const accepted = order.kg_green_accepted == null ? null : Number(order.kg_green_accepted);
    const isPending = order.status === 'Pending';

    const dirSelect = el('select', { class: 'ctrm-select' }, [
      el('option', { value: 'add',    selected: true }, ['Añadir kg']),
      el('option', { value: 'remove' },                ['Quitar kg']),
    ]);
    const amountInput = el('input', {
      type: 'number', min: '0', step: '1', placeholder: '0',
      class: 'ctrm-input mono',
    });
    const reasonInput = el('textarea', {
      rows: '2', class: 'ctrm-textarea',
      placeholder: 'Motivo (opcional): el cliente amplió, se recortó el contrato…',
    });

    const preview = el('p', { class: 'text-[12px] font-mono text-ink-500' });
    function refreshPreview() {
      const amt = Number(amountInput.value);
      if (!Number.isFinite(amt) || amt <= 0) {
        preview.textContent = '—';
        preview.className = 'text-[12px] font-mono text-ink-300';
        return;
      }
      const delta = dirSelect.value === 'remove' ? -amt : amt;
      const nextReq = required + delta;
      if (nextReq <= 0) {
        preview.textContent = `El pedido quedaría en ${fmtKg(nextReq)} — para anularlo, cancélalo.`;
        preview.className = 'text-[12px] font-mono text-crit';
        return;
      }
      preview.textContent = `${fmtKg(required)} → ${fmtKg(nextReq)}`;
      preview.className = 'text-[12px] font-mono text-ink-700 font-semibold';
    }
    dirSelect.addEventListener('change', refreshPreview);
    amountInput.addEventListener('input', refreshPreview);
    refreshPreview();

    // Qué va a pasar, dicho sin rodeos: en Pending se aplica solo; en
    // los demás estados la finca tiene que confirmar que puede producirlo.
    const notice = isPending
      ? el('p', { class: 'text-[11px] text-ink-500' },
          ['La finca todavía no ha revisado este pedido, así que el cambio se aplica de inmediato.'])
      : el('p', { class: 'text-[11px]', style: 'color:#92400e;' },
          ['La finca ya aceptó este pedido. El ajuste queda como solicitud hasta que lo confirme: '
           + 'mientras tanto, producción sigue trabajando contra la cantidad actual.']);

    const already = order.kg_green_pending_delta != null
      ? el('p', { class: 'text-[11px]', style: 'color:#92400e;' }, [
          `Ya hay un ajuste pendiente de ${Number(order.kg_green_pending_delta) > 0 ? '+' : '−'}`
          + `${fmtKg(Math.abs(Number(order.kg_green_pending_delta)))}. Si envías otro, lo reemplaza.`,
        ])
      : null;

    return el('div', { class: 'space-y-3' }, [
      el('div', { class: 'ctrm-card ctrm-card-pad space-y-1' }, [
        row('kg requeridos hoy', fmtKg(required)),
        accepted != null ? row('kg aceptados por la finca', fmtKg(accepted)) : null,
        order.max_delivery_date ? row('Entrega máxima', fmtDate(order.max_delivery_date)) : null,
      ]),
      already,
      el('div', { class: 'grid grid-cols-[1fr_1fr] gap-2' }, [
        el('div', {}, [el('label', { class: 'ctrm-label', text: 'Operación' }), dirSelect]),
        el('div', {}, [el('label', { class: 'ctrm-label', text: 'kg verde' }), amountInput]),
      ]),
      el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'Queda en' }),
        preview,
      ]),
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'Motivo' }), reasonInput]),
      notice,
      el('div', { class: 'flex justify-end gap-2 pt-2 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-primary',
          type: 'button',
          onClick: () => {
            const amt = Number(amountInput.value);
            if (!Number.isFinite(amt) || amt <= 0) {
              toast('Indica cuántos kg', 'warning'); return;
            }
            const delta = dirSelect.value === 'remove' ? -amt : amt;
            if (required + delta <= 0) {
              toast('El ajuste dejaría el pedido en cero o menos. Para anularlo, cancélalo.', 'warning', 5000);
              return;
            }
            close({ delta_kg: delta, reason: reasonInput.value.trim() || null });
          },
        }, [isPending ? 'Aplicar' : 'Enviar solicitud']),
      ]),
    ]);
  }, { title: `Ajustar kg · ${order.order_code || ''}`, wide: false });
}

/**
 * Modal de la finca para resolver el ajuste.
 * Resuelve { accept: boolean } o null si se cierra sin decidir.
 */
export function openResolveKgModal(order) {
  return openModal(({ close }) => {
    const delta = Number(order.kg_green_pending_delta || 0);
    const required = Number(order.kg_green_required || 0);
    const accepted = order.kg_green_accepted == null ? null : Number(order.kg_green_accepted);
    const adding = delta > 0;

    return el('div', { class: 'space-y-3' }, [
      el('div', { class: 'ctrm-card ctrm-card-pad space-y-1' }, [
        row('Pedido', order.order_code || '—'),
        row('Referencia', order.reference_name || '—'),
        order.max_delivery_date ? row('Entrega máxima', fmtDate(order.max_delivery_date)) : null,
      ]),
      el('div', { class: 'ctrm-card ctrm-card-pad space-y-1' }, [
        row('Forest pide', `${adding ? 'añadir' : 'quitar'} ${fmtKg(Math.abs(delta))}`,
          adding ? 'text-ok' : 'text-crit'),
        row('kg requeridos', `${fmtKg(required)} → ${fmtKg(required + delta)}`),
        accepted != null
          ? row('Tu compromiso', `${fmtKg(accepted)} → ${fmtKg(accepted + delta)}`)
          : null,
      ]),
      order.pending_delta_reason
        ? el('div', {}, [
            el('p', { class: 'ctrm-label', text: 'Motivo de Forest' }),
            el('p', { class: 'text-[12px] text-ink-700', text: order.pending_delta_reason }),
          ])
        : null,
      el('p', { class: 'text-[11px] text-ink-500' }, [
        adding
          ? 'Si aceptas, tu compromiso de producción sube y el objetivo del pedido se mueve de inmediato.'
          : 'Si aceptas, tu compromiso de producción baja. Los baches ya asignados no se liberan: '
            + 'el excedente queda marcado como tal.',
      ]),
      el('div', { class: 'flex justify-end gap-2 pt-2 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Después']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-soft text-crit', type: 'button',
          onClick: () => close({ accept: false }),
        }, ['Rechazar']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-primary', type: 'button',
          onClick: () => close({ accept: true }),
        }, ['Aceptar ajuste']),
      ]),
    ]);
  }, { title: 'Ajuste de cantidad solicitado', wide: false });
}
