// Despachos (shipments) — list + create + PDF download.
import { el, clear } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { openModal, confirmModal } from '../ui/modal.js';
import { listView } from '../ui/list.js';
import { fmtKg, fmtDate, statusLabel } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { generateShipmentPdf, generateShipmentAssignmentsPdf } from '../ui/pdf.js';
import { emptyStateCard } from '../ui/empty.js';

export async function fincaDespachosView() {
  const [shipsRes, lotsRes] = await Promise.all([
    api.shipmentsList(),
    api.lotsList({ status: 'Ready' }),
  ]);
  let shipments = shipsRes.shipments || [];
  let readyLots = lotsRes.lots || [];

  const list = el('div', { class: 'space-y-3' });

  // Si Punto Final guardo IDs en sessionStorage, abrimos el modal de
  // crear despacho preseleccionando esos lotes.
  try {
    const raw = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem('punto-final-preselect') : null;
    if (raw) {
      sessionStorage.removeItem('punto-final-preselect');
      const ids = JSON.parse(raw);
      if (Array.isArray(ids) && ids.length > 0) {
        setTimeout(() => openCreateModal(ids), 0);
      }
    }
  } catch { /* silent */ }

  function render() {
    clear(list);
    list.append(listView({
      items: shipments,
      renderItem: shipmentCard,
      pageSize: 20,
      emptyText: () => emptyStateCard({
        title: 'Aún no se han creado despachos',
        description: readyLots.length > 0
          ? `Hay ${readyLots.length} lote(s) Listos esperando.`
          : 'Cuando finca cierre el primer bache podrás crear el despacho.',
        action: readyLots.length > 0
          ? { label: '+ Nuevo despacho', onClick: () => openCreateModal() }
          : null,
      }),
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

    return el('div', { class: 'ctrm-card ctrm-card-pad space-y-3' }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
          el('span', { class: 'ctrm-code', text: s.shipment_code }),
          el('span', { class: 'font-display font-semibold text-navy text-[13px]', text: fmtDate(s.shipment_date) }),
          el('span', { class: 'ctrm-pill ok', text: 'Despachado' }),
        ]),
        el('div', { class: 'flex items-center gap-2' }, [
          el('button', {
            class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
            title: 'Remisión para la trilladora · solo data del envío',
            onClick: () => downloadPdf(s),
          }, ['↓ Remisión']),
          el('button', {
            class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
            title: 'Documento interno · asignaciones por bache a pedidos',
            onClick: () => downloadAssignmentsPdf(s),
          }, ['↓ Asignaciones']),
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
      // Per-lot tables
      el('div', { class: 'space-y-3' }, s.lots.map((lot) => lotBlock(lot))),
      s.notes
        ? el('p', { class: 'text-[11px] text-ink-500 italic border-t border-sand pt-2', text: s.notes })
        : null,
    ]);
  }

  function lotBlock(lot) {
    const kgInShipment = Number(lot.kg_green_in_shipment ?? lot.kg_green_actual ?? lot.kg_green_expected ?? 0);
    const partials = lot.partials_in_shipment || [];
    // Cuando el lote se cerro via parciales, kg_dried_output ya es la
    // suma de los parciales (lo guarda update-status). Si no hubo
    // parciales, usamos el valor crudo de la BD. Para mostrar al
    // operario preferimos siempre el dato del lote (autoritativo).
    const sumDried = lot.kg_dried_output != null
      ? Number(lot.kg_dried_output)
      : (partials.length > 0
          ? partials.reduce((s, p) => s + Number(p.kg_dried || 0), 0)
          : null);
    // Verde "real" del lote: kg_green_actual cuando esta cerrado; si no,
    // caemos al kg_green_expected (pre-proceso). El label cambia para
    // que el operario sepa que esta viendo.
    const verdeReal = lot.kg_green_actual != null ? Number(lot.kg_green_actual) : null;
    const verdeEst  = lot.kg_green_expected != null ? Number(lot.kg_green_expected) : null;
    const showVerde = verdeReal != null ? verdeReal : verdeEst;
    const verdeLabel = verdeReal != null ? 'Verde' : 'Verde estimado';

    return el('div', { class: 'rounded-md border border-sand bg-white overflow-hidden' }, [
      // Lot header (navy strip, igual al PDF)
      el('div', { class: 'flex items-center justify-between gap-2 px-3 py-2', style: 'background:#1a3a5c;' }, [
        el('div', { class: 'flex items-center gap-2 min-w-0' }, [
          el('span', { class: 'font-mono font-bold text-[12px]', style: 'color:#e7e244;', text: lot.bache_code || lot.lot_code }),
          el('span', { class: 'font-display font-semibold text-[12px] truncate', style: 'color:#fff;', text: lot.reference_name || '—' }),
        ]),
        el('span', { class: 'font-mono text-[11px]', style: 'color:#cdd5dd;', text: `${lot.process_type} · ${fmtKg(kgInShipment)}` }),
      ]),
      // Lot meta strip
      el('div', { class: 'px-3 py-2 text-[11px] text-ink-500 flex flex-wrap gap-x-4 gap-y-1 border-b border-sand' }, [
        lot.processing_stage ? el('span', {}, [`Etapa inicial: `, el('strong', { class: 'text-ink-700', text: lot.processing_stage })]) : null,
        sumDried != null ? el('span', {}, [`Peso seco: `, el('strong', { class: 'text-ink-700', text: fmtKg(sumDried) })]) : null,
        lot.factor_rendimiento != null ? el('span', {}, [`Factor: `, el('strong', { class: 'text-ink-700', text: String(lot.factor_rendimiento) })]) : null,
        showVerde != null ? el('span', {}, [`${verdeLabel}: `, el('strong', { class: 'text-ink-700', text: fmtKg(showVerde) })]) : null,
        lot.varieties && lot.varieties.length
          ? el('span', {}, [`Variedades: `, el('strong', { class: 'text-ink-700', text: lot.varieties.map((v) => v.name).join(', ') })])
          : null,
      ]),
      // Parciales en dropdown colapsable: por defecto solo se ve el
      // resumen total; el operario expande para ver fila por fila.
      partials.length > 0
        ? partialsCollapsible(partials)
        : null,
      // Assignments table
      (lot.assignments && lot.assignments.length > 0)
        ? el('div', { class: 'px-3 py-2' }, [
            el('p', { class: 'eyebrow text-[10px] mb-1', text: `Asignaciones (${lot.assignments.length})` }),
            simpleTable(
              ['Pedido', 'Cliente', 'Tipo', 'Contrato', 'Región', 'Entrega', 'kg verde'],
              lot.assignments.map((a) => {
                const o = a.order || {};
                return [
                  o.order_code || '—',
                  o.client_name || '—',
                  o.order_type || '—',
                  o.contract_code || '—',
                  (o.regions && o.regions.length > 0) ? o.regions.join(', ') : '—',
                  o.max_delivery_date ? fmtDate(o.max_delivery_date) : '—',
                  fmtKg(a.kg_green_allocated),
                ];
              }),
              ['font-mono text-navy font-semibold', '', '', 'font-mono', '', 'font-mono', 'text-right font-mono font-bold'],
            ),
          ])
        : el('p', { class: 'px-3 py-2 text-[11px] text-ink-300 italic', text: '— sin asignaciones —' }),
    ]);
  }

  function partialsCollapsible(partials) {
    const sumDried = partials.reduce((s, p) => s + Number(p.kg_dried || 0), 0);
    const sumGreen = partials.reduce((s, p) => s + Number(p.kg_green_yield || 0), 0);
    // Factor ponderado por kg seco (mismo calculo que el backend al cerrar bache).
    let avgFactor = null;
    if (sumDried > 0) {
      const weighted = partials.reduce((s, p) => s + Number(p.factor_rendimiento || 0) * Number(p.kg_dried || 0), 0);
      avgFactor = Math.round((weighted / sumDried) * 100) / 100;
    }
    const details = el('details', {
      class: 'px-3 py-2 border-b border-sand',
    }, [
      el('summary', {
        class: 'flex flex-wrap items-center gap-x-3 gap-y-1 cursor-pointer text-[11px] text-ink-500',
        style: 'list-style:none;',
      }, [
        el('span', { class: 'eyebrow text-[10px]', text: `Parciales (${partials.length}) · click para ver detalle ▸` }),
        el('span', { class: 'font-mono text-ink-700' }, [`Total seco `, el('strong', { text: fmtKg(sumDried) })]),
        el('span', { class: 'font-mono text-ink-700' }, [`Total verde `, el('strong', { text: fmtKg(sumGreen) })]),
        avgFactor != null
          ? el('span', { class: 'font-mono text-ink-700' }, [`Factor prom. `, el('strong', { text: String(avgFactor) })])
          : null,
      ]),
      el('div', { class: 'mt-2' }, [
        simpleTable(
          ['Parcial', 'kg seco', 'Factor', 'kg verde'],
          partials.map((p) => [
            `Parcial ${p.parcial_letter}`,
            fmtKg(p.kg_dried),
            String(p.factor_rendimiento),
            fmtKg(p.kg_green_yield),
          ]),
          ['', 'text-right', 'text-right', 'text-right font-bold'],
        ),
      ]),
    ]);
    return details;
  }

  function simpleTable(headers, rows, cellClasses) {
    return el('div', { class: 'overflow-x-auto' }, [
      el('table', { class: 'w-full text-[11px]' }, [
        el('thead', {}, [el('tr', { class: 'text-ink-300 uppercase tracking-loose' },
          headers.map((h, i) =>
            el('th', { class: `px-2 py-1 ${(cellClasses[i] || '').includes('text-right') ? 'text-right' : 'text-left'}` }, [h])))]),
        el('tbody', {}, rows.map((r) => el('tr', { class: 'border-t border-sand' },
          r.map((cell, i) => el('td', { class: `px-2 py-1 ${cellClasses[i] || ''} text-ink-700` }, [String(cell)]))))),
      ]),
    ]);
  }

  function downloadPdf(shipment) {
    try {
      generateShipmentPdf(shipment);
    } catch (e) { toast(e.message, 'error'); }
  }
  function downloadAssignmentsPdf(shipment) {
    try {
      generateShipmentAssignmentsPdf(shipment);
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

  function openCreateModal(preselectLotIdOrIds) {
    // Acepta string (legacy: un solo lot id) o array de ids.
    const preselectLotIds = Array.isArray(preselectLotIdOrIds)
      ? preselectLotIdOrIds
      : (preselectLotIdOrIds ? [preselectLotIdOrIds] : []);
    if (readyLots.length === 0) {
      toast('No hay lotes Listos para despachar.', 'warning', 4500);
      return;
    }
    return openModal(({ close }) => createModalBody(close, preselectLotIds), {
      title: 'Nuevo despacho', wide: true,
    });
  }

  function createModalBody(close, preselectLotIds) {
    // Selection state:
    //   wholeLots:  Set<lot_id>     — for lots without partials
    //   partials:   Set<partial_id> — for partial-mode lots
    //   lotFields:  Map<lot_id, { codigo_trilladora, codigo_mezcla, num_sacos, partials_merged }>
    const wholeLots = new Set(Array.isArray(preselectLotIds) ? preselectLotIds : []);
    const partialIds = new Set();
    const lotFields = new Map();
    const partialFields = new Map(); // partial_id → {codigo_trilladora, codigo_mezcla, num_sacos}
    function getLotFields(lotId) {
      if (!lotFields.has(lotId)) {
        lotFields.set(lotId, { codigo_trilladora: '', codigo_mezcla: '', num_sacos: '', partials_merged: true });
      }
      return lotFields.get(lotId);
    }
    function getPartialFields(pid) {
      if (!partialFields.has(pid)) {
        partialFields.set(pid, { codigo_trilladora: '', codigo_mezcla: '', num_sacos: '' });
      }
      return partialFields.get(pid);
    }

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

    // ── Destino y conductor ──
    const destinoSelect = el('select', { class: 'ctrm-input' }, [
      el('option', { value: '' }, ['— Sin especificar —']),
      el('option', { value: 'Vertical' },   ['Vertical']),
      el('option', { value: 'Tribox' },     ['Tribox']),
      el('option', { value: 'Trillanova' }, ['Trillanova']),
      el('option', { value: 'Otro' },       ['Otro']),
    ]);
    const destinoOtherInput = el('input', {
      type: 'text', class: 'ctrm-input', placeholder: 'Especificar destino',
    });
    destinoOtherInput.style.display = 'none';
    destinoSelect.addEventListener('change', () => {
      destinoOtherInput.style.display = destinoSelect.value === 'Otro' ? '' : 'none';
    });
    const driverCedula = el('input', { type: 'text', class: 'ctrm-input', placeholder: 'CC del conductor' });
    const driverPlacas = el('input', { type: 'text', class: 'ctrm-input mono', placeholder: 'Placa del vehículo' });
    const driverName   = el('input', { type: 'text', class: 'ctrm-input', placeholder: 'Nombre del conductor' });

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
              renderLots();
              recountSummary();
            },
          });
          const detailsBlock = checked ? perLotInputs(l, getLotFields(l.id)) : null;
          lotsList.append(el('div', { class: 'flex items-start gap-3 p-2 rounded-md border border-sand bg-white' }, [
            cb,
            el('div', { class: 'flex-1 min-w-0' }, [
              lotHeader, lotMeta, assignmentsLine,
              detailsBlock,
            ]),
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
              renderLots();
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

        const anySelected = partials.some((p) => partialIds.has(p.id));
        const lf = getLotFields(l.id);
        const mergedToggle = anySelected ? el('div', { class: 'flex items-center gap-2 mt-2 text-[11px]' }, [
          el('label', { class: 'inline-flex items-center gap-1' }, [
            el('input', {
              type: 'checkbox', class: 'h-3.5 w-3.5 accent-navy',
              checked: lf.partials_merged ? true : undefined,
              onChange: (e) => { lf.partials_merged = e.target.checked; renderLots(); },
            }),
            el('span', { class: 'text-ink-700', text: 'Mezclar parciales en el despacho (una sola línea con códigos compartidos)' }),
          ]),
        ]) : null;
        const perPartialControls = anySelected && !lf.partials_merged
          ? el('div', { class: 'space-y-1 mt-2' },
              partials.filter((p) => partialIds.has(p.id)).map((p) =>
                perPartialInputs(p, getPartialFields(p.id))))
          : null;
        const mergedControls = anySelected && lf.partials_merged
          ? perLotInputs(l, lf, { partialsContext: true })
          : null;
        lotsList.append(el('div', { class: 'p-2 rounded-md border border-sand bg-white' }, [
          el('div', { class: 'flex items-start justify-between gap-2 mb-1' }, [
            el('div', { class: 'flex-1 min-w-0' }, [lotHeader, lotMeta, assignmentsLine]),
            allBtn,
          ]),
          el('div', { class: 'space-y-1 mt-2' }, partialRows),
          mergedToggle,
          mergedControls,
          perPartialControls,
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
      // Destino + conductor
      el('div', { class: 'p-3 bg-cream rounded-md border border-sand space-y-2' }, [
        el('p', { class: 'eyebrow text-[10px]', text: 'Destino y conductor' }),
        el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-2' }, [
          labelled('Destino', destinoSelect),
          labelled('Especificar destino', destinoOtherInput),
        ]),
        el('div', { class: 'grid grid-cols-1 sm:grid-cols-3 gap-2' }, [
          labelled('Conductor — CC', driverCedula),
          labelled('Conductor — Nombre', driverName),
          labelled('Placas', driverPlacas),
        ]),
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
            const items = buildItems(readyLots, wholeLots, partialIds, lotFields, partialFields);
            if (items.length === 0) { toast('Selecciona al menos un lote o parcial', 'warning'); return; }
            if (destinoSelect.value === 'Otro' && !destinoOtherInput.value.trim()) {
              toast('Especifica el destino "Otro"', 'warning'); return;
            }
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
                destino_kind: destinoSelect.value || undefined,
                destino_other: destinoSelect.value === 'Otro' ? destinoOtherInput.value.trim() : undefined,
                driver_cedula: driverCedula.value.trim() || undefined,
                driver_placas: driverPlacas.value.trim() || undefined,
                driver_name:   driverName.value.trim()   || undefined,
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

// Inputs por bache (código trilladora / código mezcla / # sacos) que
// aparecen cuando el bache está seleccionado en el despacho.
function perLotInputs(_lot, fields, opts = {}) {
  const t = el('input', { type: 'text', class: 'ctrm-input mono text-[11px]',
    placeholder: 'PP-XXXX', value: fields.codigo_trilladora || '' });
  const m = el('input', { type: 'text', class: 'ctrm-input mono text-[11px]',
    placeholder: 'Código mezcla', value: fields.codigo_mezcla || '' });
  const s = el('input', { type: 'number', min: '0', step: '1', class: 'ctrm-input mono text-[11px] text-right',
    placeholder: '0', value: fields.num_sacos || '' });
  t.addEventListener('input', () => { fields.codigo_trilladora = t.value; });
  m.addEventListener('input', () => { fields.codigo_mezcla    = m.value; });
  s.addEventListener('input', () => { fields.num_sacos        = s.value === '' ? '' : Math.max(0, Math.floor(Number(s.value) || 0)); });
  return el('div', { class: `grid grid-cols-3 gap-2 mt-2 p-2 rounded-md ${opts.partialsContext ? 'bg-cream' : 'bg-cream'}` }, [
    el('label', { class: 'block' }, [
      el('span', { class: 'text-[10px] text-ink-500 uppercase tracking-eyebrow', text: 'Cód. trilladora' }),
      t,
    ]),
    el('label', { class: 'block' }, [
      el('span', { class: 'text-[10px] text-ink-500 uppercase tracking-eyebrow', text: 'Cód. mezcla' }),
      m,
    ]),
    el('label', { class: 'block' }, [
      el('span', { class: 'text-[10px] text-ink-500 uppercase tracking-eyebrow', text: '# Sacos' }),
      s,
    ]),
  ]);
}

function perPartialInputs(partial, fields) {
  const wrapper = el('div', { class: 'flex items-end gap-2 p-2 rounded-md bg-cream' }, [
    el('span', { class: 'ctrm-pill dark text-[10px]', text: `Parcial ${partial.parcial_letter}` }),
  ]);
  const t = el('input', { type: 'text', class: 'ctrm-input mono text-[11px] w-28',
    placeholder: 'PP-XXXX', value: fields.codigo_trilladora || '' });
  const m = el('input', { type: 'text', class: 'ctrm-input mono text-[11px] w-32',
    placeholder: 'Cód. mezcla', value: fields.codigo_mezcla || '' });
  const s = el('input', { type: 'number', min: '0', step: '1', class: 'ctrm-input mono text-[11px] w-20 text-right',
    placeholder: '0', value: fields.num_sacos || '' });
  t.addEventListener('input', () => { fields.codigo_trilladora = t.value; });
  m.addEventListener('input', () => { fields.codigo_mezcla    = m.value; });
  s.addEventListener('input', () => { fields.num_sacos        = s.value === '' ? '' : Math.max(0, Math.floor(Number(s.value) || 0)); });
  wrapper.append(
    el('label', {}, [el('span', { class: 'text-[10px] block text-ink-500', text: 'Trilladora' }), t]),
    el('label', {}, [el('span', { class: 'text-[10px] block text-ink-500', text: 'Mezcla' }),     m]),
    el('label', {}, [el('span', { class: 'text-[10px] block text-ink-500', text: '# Sacos' }),    s]),
  );
  return wrapper;
}

function buildItems(readyLots, wholeLots, partialIds, lotFields, partialFields) {
  const items = [];
  const norm = (f) => ({
    codigo_trilladora: (f.codigo_trilladora || '').trim() || null,
    codigo_mezcla:     (f.codigo_mezcla || '').trim() || null,
    num_sacos:         f.num_sacos === '' || f.num_sacos == null ? null : Number(f.num_sacos),
  });
  for (const l of readyLots) {
    const partials = l.partials || [];
    const lf = lotFields.get(l.id) || { codigo_trilladora: '', codigo_mezcla: '', num_sacos: '', partials_merged: true };
    if (partials.length === 0) {
      if (wholeLots.has(l.id)) {
        items.push({
          production_lot_id: l.id, partial_ids: null,
          ...norm(lf),
          partials_merged: true,
        });
      }
    } else {
      const selected = partials.filter((p) => partialIds.has(p.id)).map((p) => p.id);
      if (selected.length === 0) continue;
      if (lf.partials_merged !== false) {
        // Mezclar: una sola entrada con todos los partials.
        items.push({
          production_lot_id: l.id, partial_ids: selected,
          ...norm(lf),
          partials_merged: true,
        });
      } else {
        // Separar: una entrada por parcial con sus propios códigos.
        for (const pid of selected) {
          const pf = partialFields.get(pid) || { codigo_trilladora: '', codigo_mezcla: '', num_sacos: '' };
          items.push({
            production_lot_id: l.id, partial_ids: [pid],
            ...norm(pf),
            partials_merged: false,
          });
        }
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
