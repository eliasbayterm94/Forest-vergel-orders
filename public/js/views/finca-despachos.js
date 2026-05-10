// Despachos (shipments) — list + create + PDF download.
import { el, clear } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { openModal, confirmModal } from '../ui/modal.js';
import { listView } from '../ui/list.js';
import { fmtKg, fmtDate, statusLabel } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { generateShipmentPdf } from '../ui/pdf.js';

export async function fincaDespachosView() {
  const [shipsRes, lotsRes] = await Promise.all([
    api.shipmentsList(),
    api.lotsList({ status: 'Ready' }),
  ]);
  let shipments = shipsRes.shipments || [];
  let readyLots = lotsRes.lots || [];

  const list = el('div', { class: 'space-y-3' });

  function render() {
    clear(list);
    list.append(listView({
      items: shipments,
      renderItem: shipmentCard,
      pageSize: 20,
      emptyText: 'Aún no se han creado despachos.',
      searchPlaceholder: 'Buscar código de despacho, lote, pedido...',
      searchMatch: (s, q) => {
        const lo = q.toLowerCase();
        if ((s.shipment_code || '').toLowerCase().includes(lo)) return true;
        if ((s.notes || '').toLowerCase().includes(lo)) return true;
        for (const l of s.lots || []) {
          if ((l.bache_code || '').toLowerCase().includes(lo)) return true;
          if ((l.lot_code || '').toLowerCase().includes(lo)) return true;
          if ((l.reference_name || '').toLowerCase().includes(lo)) return true;
          for (const a of l.assignments || []) {
            if ((a.order?.order_code || '').toLowerCase().includes(lo)) return true;
            if ((a.order?.client_name || '').toLowerCase().includes(lo)) return true;
          }
        }
        return false;
      },
      sorts: [
        { key: 'date_desc', label: 'Fecha: más reciente', getter: (s) => s.shipment_date, dir: 'desc' },
        { key: 'date_asc',  label: 'Fecha: más antigua',  getter: (s) => s.shipment_date, dir: 'asc' },
        { key: 'kg_desc',   label: 'Mayor kg verde',      getter: (s) => Number(s.totals?.kg_green || 0), dir: 'desc' },
      ],
      defaultSort: 'date_desc',
      totals: [
        { label: 'Despachos', value: (arr) => String(arr.length) },
        { label: 'Lotes',     value: (arr) => String(arr.reduce((s, x) => s + (x.totals?.lot_count || x.lots.length), 0)) },
        { label: 'Pedidos',   value: (arr) => {
          const ids = new Set();
          arr.forEach((s) => s.lots.forEach((l) => l.assignments.forEach((a) => a.order && ids.add(a.order.id))));
          return String(ids.size);
        } },
        { label: 'Verde',     value: (arr) => fmtKg(arr.reduce((s, x) => s + Number(x.totals?.kg_green || 0), 0)) },
      ],
    }));
  }
  render();

  return chrome(el('div', {}, [
    pageTitle('Despachos', 'Mezcla lotes Listos en un despacho y genera PDF'),
    el('div', { class: 'mb-4 flex items-center justify-between gap-2' }, [
      el('p', { class: 'text-[12px] text-ink-500' },
        [`${readyLots.length} lote(s) Listos esperando despacho`]),
      el('button', {
        class: 'ctrm-btn ctrm-btn-yellow uppercase tracking-eyebrow text-[11px] py-2.5 px-5',
        onClick: () => openCreateModal(),
      }, ['+ Nuevo despacho']),
    ]),
    list,
  ]));

  async function reload() {
    const [s, l] = await Promise.all([
      api.shipmentsList(),
      api.lotsList({ status: 'Ready' }),
    ]);
    shipments = s.shipments || [];
    readyLots = l.lots || [];
    render();
  }

  function shipmentCard(s) {
    const t = s.totals || {};
    const orderRefs = new Set();
    s.lots.forEach((l) => l.assignments.forEach((a) => a.order && orderRefs.add(a.order.order_code)));

    return el('div', { class: 'ctrm-card ctrm-card-pad' }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-2' }, [
        el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
          el('span', { class: 'ctrm-code', text: s.shipment_code }),
          el('span', { class: 'font-display font-semibold text-navy text-[13px]', text: fmtDate(s.shipment_date) }),
          el('span', { class: 'ctrm-pill ok', text: 'Despachado' }),
        ]),
        el('div', { class: 'flex items-center gap-2' }, [
          el('button', {
            class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
            onClick: () => downloadPdf(s),
          }, ['↓ PDF']),
          el('button', {
            class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm text-crit',
            title: 'Cancelar despacho · revierte lotes y pedidos',
            onClick: () => cancelShipment(s),
          }, ['Cancelar']),
        ]),
      ]),
      el('div', { class: 'flex flex-wrap text-[12px] text-ink-500 gap-x-4 gap-y-1 font-mono' }, [
        meta('Lotes',   String(t.lot_count ?? s.lots.length)),
        meta('Pedidos', String(t.order_count ?? '—')),
        meta('Verde',   fmtKg(t.kg_green ?? 0)),
        meta('Asignado', fmtKg(t.kg_green_allocated ?? 0)),
      ]),
      orderRefs.size > 0
        ? el('div', { class: 'flex flex-wrap gap-1 mt-2' },
            [...orderRefs].map((c) => el('span', { class: 'ctrm-code', text: c })))
        : null,
      s.notes
        ? el('p', { class: 'text-[11px] text-ink-500 italic mt-2 border-t border-sand pt-2', text: s.notes })
        : null,
    ]);
  }

  function downloadPdf(shipment) {
    try {
      generateShipmentPdf(shipment);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function cancelShipment(shipment) {
    const lotCount = shipment.totals?.lot_count ?? shipment.lots.length;
    const ok = await confirmModal(
      `¿Cancelar despacho ${shipment.shipment_code}? ` +
      `Los ${lotCount} lote(s) regresan a Ready y los pedidos completados por este despacho ` +
      `vuelven a InProduction. Esta acción no se puede deshacer fácilmente.`,
      { title: 'Cancelar despacho', confirmText: 'Cancelar despacho', danger: true },
    );
    if (!ok) return;
    try {
      const r = await api.shipmentsCancel({ shipment_id: shipment.id });
      const c = r.cancelled || {};
      const lotsBack = (c.lots_reverted_to_ready || []).length;
      const ordersBack = (c.orders_reverted_to_in_production || []).length;
      const parts = [`Despacho ${shipment.shipment_code} cancelado`];
      if (lotsBack > 0) parts.push(`${lotsBack} lote(s) → Ready`);
      if (ordersBack > 0) parts.push(`${ordersBack} pedido(s) → InProduction`);
      toast(parts.join(' · '), 'success', 5000);
      await reload();
    } catch (e) { toast(e.message, 'error'); }
  }

  function openCreateModal(preselectLotId) {
    if (readyLots.length === 0) {
      toast('No hay lotes Listos para despachar.', 'warning', 4500);
      return;
    }
    return openModal(({ close }) => createModalBody(close, preselectLotId), {
      title: 'Nuevo despacho', wide: true,
    });
  }

  function createModalBody(close, preselectLotId) {
    // Selection state:
    //   wholeLots:  Set<lot_id>     — for lots without partials
    //   partials:   Set<partial_id> — for partial-mode lots
    const wholeLots = new Set(preselectLotId ? [preselectLotId] : []);
    const partialIds = new Set();

    const dateInput = el('input', {
      type: 'date', value: new Date().toISOString().slice(0, 10),
      class: 'ctrm-input',
    });
    const codeInput = el('input', {
      type: 'text', placeholder: 'Auto: DSP-YYYY-NNNN',
      class: 'ctrm-input mono',
    });
    const notesInput = el('textarea', {
      rows: '2', placeholder: 'Notas (opcional)',
      class: 'ctrm-textarea',
    });

    const counter = el('div', {
      class: 'rounded-lg bg-cream border border-sand p-3 text-[12px] flex flex-wrap items-center gap-x-4 gap-y-1 font-mono',
    });

    function selectedLots() {
      // Lots that contribute SOMETHING to this shipment.
      return readyLots.filter((l) => {
        if ((l.partials || []).length === 0) return wholeLots.has(l.id);
        return (l.partials || []).some((p) => partialIds.has(p.id));
      });
    }
    function selectedKg() {
      let total = 0;
      for (const l of readyLots) {
        if ((l.partials || []).length === 0) {
          if (wholeLots.has(l.id)) total += Number(l.kg_green_actual ?? l.kg_green_expected ?? 0);
        } else {
          for (const p of l.partials) {
            if (partialIds.has(p.id)) total += Number(p.kg_green_yield || 0);
          }
        }
      }
      return total;
    }

    const recountSummary = () => {
      clear(counter);
      const sel = selectedLots();
      const totalKg = selectedKg();
      const orderIds = new Set();
      sel.forEach((l) => (l.assignments || []).forEach((a) => orderIds.add(a.demand_order_id)));
      const partialCount = [...partialIds].length;
      counter.append(
        infoChip('Lotes', String(sel.length)),
        partialCount > 0 ? infoChip('Parciales', String(partialCount)) : null,
        infoChip('kg verde', fmtKg(totalKg)),
        infoChip('Pedidos involucrados', String(orderIds.size)),
      );
    };

    const lotsList = el('div', { class: 'space-y-1.5 max-h-[50vh] overflow-y-auto pr-1' });
    function renderLots() {
      clear(lotsList);
      readyLots.forEach((l) => {
        const totalAlloc = (l.assignments || []).reduce((s, a) => s + Number(a.kg_green_allocated || 0), 0);
        const partials = l.partials || [];
        const lotHeader = el('div', { class: 'flex items-center gap-2 flex-wrap mb-1' }, [
          el('span', { class: 'ctrm-code', text: l.bache_code || l.lot_code }),
          el('span', { class: 'text-[12px] font-display font-semibold text-navy', text: l.reference_name || '—' }),
          el('span', { class: 'ctrm-pill muted', text: l.process_type }),
          partials.length > 0
            ? el('span', { class: 'ctrm-pill', text: `${partials.length} parcial(es)` })
            : null,
        ]);
        const lotMeta = el('div', { class: 'text-[11px] text-ink-500 font-mono' }, [
          `Verde lote: ${fmtKg(l.kg_green_actual ?? l.kg_green_expected ?? 0)}  ·  Asignado: ${fmtKg(totalAlloc)}  ·  ${(l.assignments || []).length} pedido(s)`,
        ]);
        const assignmentsLine = (l.assignments || []).length > 0
          ? el('div', { class: 'flex flex-wrap gap-1 mt-1' },
              (l.assignments || []).map((a) => el('span', { class: 'ctrm-code text-[10px]' }, [
                `${a.order?.order_code || '?'}: ${fmtKg(a.kg_green_allocated)}`,
              ])))
          : el('p', { class: 'text-[11px] text-warn mt-1', text: '⚠ Sin asignaciones — el despacho no completará ningún pedido.' });

        if (partials.length === 0) {
          // Whole-lot row
          const checked = wholeLots.has(l.id);
          const cb = el('input', {
            type: 'checkbox', class: 'h-4 w-4 accent-navy mt-1', checked,
            onChange: (e) => {
              if (e.target.checked) wholeLots.add(l.id); else wholeLots.delete(l.id);
              recountSummary();
            },
          });
          lotsList.append(el('label', { class: 'flex items-start gap-3 p-2 rounded-md border border-sand bg-white cursor-pointer hover:border-navy' }, [
            cb,
            el('div', { class: 'flex-1 min-w-0' }, [lotHeader, lotMeta, assignmentsLine]),
          ]));
          return;
        }

        // Partial-mode card
        const partialRows = partials.map((p) => {
          const isShipped  = !!p.shipment_id;
          const isRejected = !!p.rejected_at;
          const disabled   = isShipped || isRejected;
          const checked    = partialIds.has(p.id);
          const cb = el('input', {
            type: 'checkbox', class: 'h-4 w-4 accent-navy',
            checked, disabled: disabled ? 'true' : null,
            onChange: (e) => {
              if (e.target.checked) partialIds.add(p.id); else partialIds.delete(p.id);
              recountSummary();
            },
          });
          let badge = null;
          if (isShipped)  badge = el('span', { class: 'ctrm-pill muted', text: `En ${p.shipment_code || 'otro despacho'}` });
          else if (isRejected) badge = el('span', { class: 'ctrm-pill urgency-red', text: 'Rechazado' });
          return el('label', {
            class: `flex items-center gap-3 px-2 py-1.5 rounded-md border ${disabled ? 'border-sand bg-cream opacity-60' : 'border-sand bg-white hover:border-navy cursor-pointer'}`,
          }, [
            cb,
            el('div', { class: 'flex-1 min-w-0 flex items-center gap-2 flex-wrap' }, [
              el('span', { class: 'ctrm-pill dark', text: `Parcial ${p.parcial_letter}` }),
              el('span', { class: 'text-[11px] font-mono text-ink-700' }, [
                `${fmtKg(p.kg_dried)} seco · factor ${p.factor_rendimiento} → `,
                el('strong', { class: 'text-navy', text: fmtKg(p.kg_green_yield) }),
                ' verde',
              ]),
              badge,
            ]),
          ]);
        });

        const allBtn = el('button', {
          class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
          type: 'button',
          onClick: () => {
            const eligible = partials.filter((p) => !p.shipment_id && !p.rejected_at);
            const allSelected = eligible.every((p) => partialIds.has(p.id));
            for (const p of eligible) {
              if (allSelected) partialIds.delete(p.id); else partialIds.add(p.id);
            }
            renderLots();
            recountSummary();
          },
        }, [partials.filter((p) => !p.shipment_id && !p.rejected_at).every((p) => partialIds.has(p.id))
            ? 'Quitar todos' : 'Seleccionar todos']);

        lotsList.append(el('div', { class: 'p-2 rounded-md border border-sand bg-white' }, [
          el('div', { class: 'flex items-start justify-between gap-2 mb-1' }, [
            el('div', { class: 'flex-1 min-w-0' }, [lotHeader, lotMeta, assignmentsLine]),
            allBtn,
          ]),
          el('div', { class: 'space-y-1 mt-2' }, partialRows),
        ]));
      });
    }
    renderLots();
    recountSummary();

    return el('div', { class: 'space-y-3' }, [
      el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-3' }, [
        labelled('Fecha de despacho', dateInput),
        labelled('Código (opcional)', codeInput),
      ]),
      labelled('Notas', notesInput),
      el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'Lotes / parciales Listos a incluir' }),
        lotsList,
      ]),
      counter,
      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-primary',
          type: 'button',
          onClick: async () => {
            const items = buildItems(readyLots, wholeLots, partialIds);
            if (items.length === 0) { toast('Selecciona al menos un lote o parcial', 'warning'); return; }
            const partialCount = items.reduce((s, it) => s + (it.partial_ids ? it.partial_ids.length : 0), 0);
            const wholeCount   = items.filter((it) => !it.partial_ids).length;
            const summary = [
              wholeCount   > 0 ? `${wholeCount} lote(s) completos` : null,
              partialCount > 0 ? `${partialCount} parcial(es)`     : null,
            ].filter(Boolean).join(' + ');
            const ok = await confirmModal(
              `Despacho con ${summary}. Los pedidos asignados podrán completarse. ¿Continuar?`,
              { title: 'Confirmar despacho' },
            );
            if (!ok) return;
            try {
              const r = await api.shipmentsCreate({
                shipment_code: codeInput.value.trim() || undefined,
                shipment_date: dateInput.value,
                notes: notesInput.value || undefined,
                items,
              });
              const compl = (r.completions || []).length;
              toast(
                `Despacho ${r.shipment.shipment_code} creado${compl ? ` · ${compl} pedido(s) completado(s)` : ''}`,
                'success', 4500,
              );
              close({ ok: true });
              await reload();
            } catch (e) { toast(e.message, 'error'); }
          },
        }, ['Crear despacho']),
      ]),
    ]);
  }
}

function buildItems(readyLots, wholeLots, partialIds) {
  const items = [];
  for (const l of readyLots) {
    const partials = l.partials || [];
    if (partials.length === 0) {
      if (wholeLots.has(l.id)) {
        items.push({ production_lot_id: l.id, partial_ids: null });
      }
    } else {
      const selected = partials.filter((p) => partialIds.has(p.id)).map((p) => p.id);
      if (selected.length > 0) {
        items.push({ production_lot_id: l.id, partial_ids: selected });
      }
    }
  }
  return items;
}

// ── helpers ────────────────────────────────────────────────────────
function labelled(label, child) {
  return el('div', {}, [el('label', { class: 'ctrm-label', text: label }), child]);
}

function meta(label, value) {
  return el('span', { class: 'inline-flex items-baseline gap-1' }, [
    el('span', { class: 'text-ink-300 uppercase tracking-loose text-[10px] font-sans font-semibold', text: label }),
    el('strong', { class: 'text-ink-700 font-mono', text: value }),
  ]);
}

function infoChip(label, value) {
  return el('span', { class: 'inline-flex items-center gap-1.5' }, [
    el('span', { class: 'text-ink-500 uppercase tracking-loose text-[10px]', text: label }),
    el('strong', { class: 'text-navy', text: value }),
  ]);
}

// Re-exported so finca-lots can open the modal pre-selecting a lot.
export function openShipmentModalForLot(_lotId) {
  // Navigate to the despachos view; the user will then click "+ Nuevo
  // despacho" to open the create modal. Keeping this stub so future
  // versions can deep-link with the lot pre-checked.
  if (location.hash !== '#/finca/despachos') location.hash = '/finca/despachos';
}
