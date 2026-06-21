// Modal compartido para asignar un bache a una orden FV existente
// o a una compra directa. Usado por:
//   - /finca/punto-final (Ready, "+ Asignar")
//   - /finca/despachos   (Delivered, sub-tabla del dropdown)
//
// Producción puede asignar cualquier bache a cualquier pedido activo;
// el único control es el de inventario en el backend
// (trg_loa_lot_capacity). Para baches ya Delivered el endpoint
// dispara maybeCompleteOrder y el dispatch automático.

import { el } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { openModal } from '../ui/modal.js';
import { fmtKg } from '../ui/format.js';
import { api } from '../api.js';

const ACTIVE = new Set(['Accepted', 'PartiallyAccepted', 'InProduction', 'Completed']);

// Abre el modal de asignación. Si no se pasan `orders`, los carga
// desde el backend. Devuelve { ok: true } si el operario confirmó
// y la llamada fue exitosa, null si canceló.
export async function openAssignModal(lot, { orders } = {}) {
  let activeOrders = orders;
  if (!activeOrders) {
    try {
      const r = await api.ordersList({});
      activeOrders = r.orders || [];
    } catch (e) {
      toast(e.message || 'No pude cargar pedidos', 'error');
      return null;
    }
  }
  const compatibleOrders = activeOrders.filter((o) => ACTIVE.has(o.status));
  // El campo kg_green_available existe para baches Ready (Punto Final).
  // Para baches ya Delivered preferimos kg_green_actual.
  const available = Number(
    lot.kg_green_available != null
      ? lot.kg_green_available
      : (lot.kg_green_actual ?? lot.kg_green_expected ?? 0),
  );

  const out = await openModal(({ close }) => {
    let mode = 'directa'; // 'directa' | 'pedido'

    const clientInput = el('input', { type: 'text', class: 'ctrm-input w-full', placeholder: 'Nombre del cliente' });
    const notesInput  = el('input', { type: 'text', class: 'ctrm-input w-full', placeholder: 'Notas (opcional)' });

    const orderSelect = el('select', { class: 'ctrm-input w-full' }, [
      el('option', { value: '' }, ['— Selecciona un pedido —']),
      ...compatibleOrders.map((o) => el('option', { value: o.id },
        [`${o.order_code || o.id.slice(0, 8)}${o.client_name ? ' · ' + o.client_name : ''} · acepta ${fmtKg(o.kg_green_accepted || o.kg_green_required || 0)}`])),
    ]);

    const kgInput = el('input', {
      type: 'number', step: '0.01', min: '0.01', max: String(available),
      value: available > 0 ? String(available) : '',
      class: 'ctrm-input mono text-right w-full',
      placeholder: `Máx ${fmtKg(available)}`,
    });

    const directaBox = el('div', { class: 'space-y-2' }, [
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'Cliente' }), clientInput]),
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'Notas' }), notesInput]),
    ]);
    const pedidoBox = el('div', { class: 'space-y-2' }, [
      compatibleOrders.length === 0
        ? el('p', { class: 'text-[12px] text-warn', text: 'No hay pedidos activos disponibles.' })
        : el('div', {}, [el('label', { class: 'ctrm-label', text: 'Pedido' }), orderSelect]),
    ]);
    pedidoBox.style.display = 'none';

    const tabBtn = (key, label) => el('button', {
      type: 'button',
      class: `ctrm-btn ctrm-btn-xs ${mode === key ? 'ctrm-btn-primary' : 'ctrm-btn-soft'}`,
      onClick: () => {
        mode = key;
        directaBox.style.display = key === 'directa' ? '' : 'none';
        pedidoBox.style.display  = key === 'pedido'  ? '' : 'none';
        tabs.replaceChildren(tabBtn('directa', 'Compra directa'), tabBtn('pedido', 'Pedido existente'));
      },
    }, [label]);
    const tabs = el('div', { class: 'flex gap-2' }, [tabBtn('directa', 'Compra directa'), tabBtn('pedido', 'Pedido existente')]);

    return el('div', { class: 'space-y-3' }, [
      el('div', { class: 'rounded-lg bg-cream border border-sand p-3 text-[12px]' }, [
        el('p', {}, [
          `Bache `, el('strong', { class: 'text-navy', text: lot.bache_code || lot.blend_code || lot.lot_code }),
          ` · disponible `, el('strong', { class: 'text-ok', text: `${fmtKg(available)} kg verde` }),
        ]),
      ]),
      tabs,
      directaBox,
      pedidoBox,
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'kg verde a asignar' }), kgInput]),
      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { type: 'button', class: 'ctrm-btn ctrm-btn-ghost', onClick: () => close(null) }, ['Cancelar']),
        el('button', { type: 'button', class: 'ctrm-btn ctrm-btn-primary', onClick: async () => {
          const kg = Number(kgInput.value);
          if (!Number.isFinite(kg) || kg <= 0) { toast('Indica kg verde > 0', 'warning'); return; }
          if (kg > available + 0.01) { toast(`Excede el disponible (${fmtKg(available)} kg verde)`, 'error'); return; }
          try {
            if (mode === 'directa') {
              const client = clientInput.value.trim();
              if (!client) { toast('Indica el nombre del cliente', 'warning'); return; }
              await api.lotPurchaseCreate({
                production_lot_id: lot.id, client_name: client,
                kg_green_allocated: kg, notes: notesInput.value || undefined,
              });
            } else {
              if (!orderSelect.value) { toast('Selecciona un pedido', 'warning'); return; }
              await api.assignmentsCreate({
                production_lot_id: lot.id,
                assignments: [{ demand_order_id: orderSelect.value, kg_green_allocated: kg }],
              });
            }
            close({ ok: true });
          } catch (e) { toast(e.message || 'Error al asignar', 'error'); }
        } }, ['Asignar']),
      ]),
    ]);
  }, { title: `Asignar ${lot.bache_code || lot.lot_code}` });

  return out;
}
