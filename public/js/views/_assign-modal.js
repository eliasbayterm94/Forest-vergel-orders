// Modal compartido para asignar un bache a una orden FV existente
// o a una compra directa. Usado por:
//   - /finca/punto-final (Ready, "+ Asignar")
//   - /finca/despachos   (Delivered, sub-tabla del dropdown)
//
// Producción puede asignar cualquier bache a cualquier pedido activo;
// el único control es el de inventario en el backend
// (trg_loa_lot_capacity). Para baches ya Delivered el endpoint
// dispara maybeCompleteOrder y el dispatch automático.
//
// El modal SIEMPRE muestra al operario el desglose:
//   · Total (kg verde del bache)
//   · Asignado a otros pedidos (cada uno con su código)
//   · Comprado (compras directas, cada una con cliente)
//   · Disponible para asignar  (autocomplete del input)
// Así nunca te bloquea el endpoint por sobrecupo: ya ves lo que hay.

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
  // Si el lote no trae kg_green_available, purchases o assignments
  // (caso típico: vino de shipments-list que NO embebe compras),
  // pedimos la versión canónica de production-lots-list para
  // mostrar el desglose correcto.
  let canonicalLot = lot;
  const needsFreshFetch =
    lot.kg_green_available == null ||
    lot.purchases == null ||
    lot.assignments == null;
  if (needsFreshFetch && lot.id) {
    try {
      const r = await api.lotsList({ id: lot.id });
      const fresh = (r.lots || [])[0];
      if (fresh) canonicalLot = fresh;
    } catch { /* silent: usamos el lot como vino */ }
  }

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

  // Desglose autoritativo: total - asignado - comprado = disponible.
  const total = Number(canonicalLot.kg_green_actual ?? canonicalLot.kg_green_expected ?? 0);
  const assignments = canonicalLot.assignments || [];
  const purchases = canonicalLot.purchases || [];
  const sumAssigned = assignments.reduce((s, a) => s + Number(a.kg_green_allocated || 0), 0);
  const sumPurchased = purchases.reduce((s, p) => s + Number(p.kg_green_allocated || 0), 0);
  const available = canonicalLot.kg_green_available != null
    ? Number(canonicalLot.kg_green_available)
    : Math.max(0, total - sumAssigned - sumPurchased);

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
      // Panel de desglose: total / asignado / comprado / disponible
      el('div', { class: 'rounded-lg bg-cream border border-sand p-3 space-y-2 text-[12px]' }, [
        el('p', { class: 'font-display font-semibold text-[13px] text-navy' }, [
          'Bache ',
          el('span', { class: 'ctrm-code', text: canonicalLot.bache_code || canonicalLot.blend_code || canonicalLot.lot_code }),
        ]),
        el('div', { class: 'grid grid-cols-2 gap-x-4 gap-y-1 font-mono' }, [
          summaryRow('Total',     fmtKg(total), 'text-navy'),
          summaryRow('Asignado',  fmtKg(sumAssigned), 'text-ink-700'),
          summaryRow('Comprado',  fmtKg(sumPurchased), 'text-ink-700'),
          summaryRow('Disponible', fmtKg(available), available > 0.01 ? 'text-ok font-bold' : 'text-crit font-bold'),
        ]),
        assignments.length > 0
          ? el('div', { class: 'border-t border-sand pt-2 space-y-1' }, [
              el('p', { class: 'eyebrow text-[9px]', text: `Asignaciones existentes (${assignments.length})` }),
              ...assignments.map((a) => {
                const o = a.order || {};
                const code = o.order_code || (a.demand_order_id ? a.demand_order_id.slice(0, 8) : '—');
                const client = o.client_name ? ` · ${o.client_name}` : '';
                return el('p', { class: 'font-mono text-[11px] text-ink-700 flex items-baseline justify-between' }, [
                  el('span', {}, [
                    el('span', { class: 'text-navy font-semibold', text: code }),
                    el('span', { class: 'text-ink-500', text: client }),
                  ]),
                  el('strong', { text: fmtKg(a.kg_green_allocated) }),
                ]);
              }),
            ])
          : null,
        purchases.length > 0
          ? el('div', { class: 'border-t border-sand pt-2 space-y-1' }, [
              el('p', { class: 'eyebrow text-[9px]', text: `Compras directas (${purchases.length})` }),
              ...purchases.map((p) => el('p', { class: 'font-mono text-[11px] text-ink-700 flex items-baseline justify-between' }, [
                el('span', { class: 'text-ink-700', text: p.client_name || '—' }),
                el('strong', { text: fmtKg(p.kg_green_allocated) }),
              ])),
            ])
          : null,
      ]),
      tabs,
      directaBox,
      pedidoBox,
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'kg verde a asignar' }), kgInput]),
      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { type: 'button', class: 'ctrm-btn ctrm-btn-ghost', onClick: () => close(null) }, ['Cancelar']),
        el('button', { type: 'button', class: 'ctrm-btn ctrm-btn-action', onClick: async () => {
          const kg = Number(kgInput.value);
          if (!Number.isFinite(kg) || kg <= 0) { toast('Indica kg verde > 0', 'warning'); return; }
          if (kg > available + 0.01) { toast(`Excede el disponible (${fmtKg(available)} kg verde)`, 'error'); return; }
          try {
            if (mode === 'directa') {
              const client = clientInput.value.trim();
              if (!client) { toast('Indica el nombre del cliente', 'warning'); return; }
              await api.lotPurchaseCreate({
                production_lot_id: canonicalLot.id, client_name: client,
                kg_green_allocated: kg, notes: notesInput.value || undefined,
              });
            } else {
              if (!orderSelect.value) { toast('Selecciona un pedido', 'warning'); return; }
              await api.assignmentsCreate({
                production_lot_id: canonicalLot.id,
                assignments: [{ demand_order_id: orderSelect.value, kg_green_allocated: kg }],
              });
            }
            close({ ok: true });
          } catch (e) { toast(e.message || 'Error al asignar', 'error'); }
        } }, ['Asignar']),
      ]),
    ]);
  }, { title: `Asignar ${canonicalLot.bache_code || canonicalLot.lot_code}` });

  return out;
}

function summaryRow(label, value, valueClass = '') {
  return el('div', { class: 'flex items-baseline justify-between' }, [
    el('span', { class: 'text-ink-500 uppercase tracking-loose text-[10px]', text: label }),
    el('strong', { class: valueClass, text: value }),
  ]);
}
