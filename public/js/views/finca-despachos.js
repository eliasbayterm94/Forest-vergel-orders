// Despachos (shipments) — list + create + PDF download.
import { el, clear } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { openModal, confirmModal } from '../ui/modal.js';
import { listView } from '../ui/list.js';
import { fmtKg, fmtDate, statusLabel } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { currentQuery, navigate } from '../router.js';
import { generateShipmentPdf, generateShipmentAssignmentsPdf, generateShipmentPrepPdf } from '../ui/pdf.js';
import { emptyStateCard } from '../ui/empty.js';
import { createViewMode } from '../ui/view-mode.js';
import { openAssignModal } from './_assign-modal.js';

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

  // Si llegamos desde una pill de Punto Final, scrolleamos y
  // resaltamos la card del despacho señalado.
  function focusFromQuery() {
    try {
      const target = currentQuery().get('focus');
      if (!target) return;
      setTimeout(() => {
        const card = document.querySelector(`[data-shipment-id="${target}"]`);
        if (!card) return;
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.style.transition = 'box-shadow 0.4s';
        card.style.boxShadow = '0 0 0 3px rgba(231, 226, 68, 0.8)';
        setTimeout(() => { card.style.boxShadow = ''; }, 2000);
      }, 50);
    } catch { /* silent */ }
  }

  const vm = createViewMode('finca-despachos', { onChange: () => render() });
  // Filas expandidas por id de shipment (sólo aplica a vista tabla).
  const expanded = new Set();
  // Estado del search para la vista tabla (cards lo gestiona listView).
  let tableSearch = '';

  function matchSearch(s, q) {
    if (!q) return true;
    const lo = q.toLowerCase();
    if ((s.shipment_code || '').toLowerCase().includes(lo)) return true;
    if ((s.notes || '').toLowerCase().includes(lo)) return true;
    if ((s.destino_kind || '').toLowerCase().includes(lo)) return true;
    if ((s.destino_other || '').toLowerCase().includes(lo)) return true;
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
  }

  function render() {
    clear(list);
    if (vm.mode() === 'table') {
      list.append(renderTableView());
    } else {
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
        searchMatch: matchSearch,
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
  }

  // ── Vista tabla ────────────────────────────────────────────────
  function renderTableView() {
    const wrap = el('div', { class: 'space-y-3' });
    const searchInput = el('input', {
      type: 'text', value: tableSearch,
      placeholder: 'Buscar código, destino, lote, pedido…',
      class: 'ctrm-input w-full sm:w-80',
      onInput: (e) => { tableSearch = e.target.value; renderTableBody(); },
    });
    const tableEl = el('div', { class: 'overflow-x-auto ctrm-card' });
    function renderTableBody() {
      clear(tableEl);
      const shown = shipments
        .filter((s) => matchSearch(s, tableSearch))
        .slice()
        .sort((a, b) => (b.shipment_date || '').localeCompare(a.shipment_date || ''));
      if (shown.length === 0) {
        tableEl.append(emptyStateCard({
          title: shipments.length === 0 ? 'Aún no se han creado despachos' : 'Sin resultados',
          description: shipments.length === 0
            ? (readyLots.length > 0 ? `Hay ${readyLots.length} lote(s) Listos esperando.` : 'Cuando finca cierre el primer bache podrás crear el despacho.')
            : 'Ajusta la búsqueda.',
        }));
        return;
      }

      const tbody = el('tbody', {});
      for (const s of shown) {
        const t = s.totals || {};
        const isExp = expanded.has(s.id);
        const destinoLabel = s.destino_kind === 'Otro'
          ? `Otro${s.destino_other ? ': ' + s.destino_other : ''}`
          : (s.destino_kind || '—');

        const expandBtn = el('button', {
          type: 'button',
          class: 'ctrm-btn ctrm-btn-ghost ctrm-btn-xs',
          title: isExp ? 'Ocultar detalle' : 'Ver detalle por bache',
          onClick: (e) => {
            e.stopPropagation();
            if (isExp) expanded.delete(s.id); else expanded.add(s.id);
            renderTableBody();
          },
        }, [isExp ? '▾' : '▸']);

        tbody.append(el('tr', {
          class: 'hover:bg-cream cursor-pointer',
          'data-shipment-id': s.id,
          onClick: () => {
            if (isExp) expanded.delete(s.id); else expanded.add(s.id);
            renderTableBody();
          },
        }, [
          el('td', { class: 'w-8 text-center' }, [expandBtn]),
          el('td', { class: 'font-mono text-navy font-semibold' }, [
            el('span', { class: 'ctrm-code', text: s.shipment_code || '—' }),
            s.status === 'draft' ? draftChip() : null,
          ]),
          el('td', { class: 'font-mono text-[12px]', text: fmtDate(s.shipment_date) }),
          el('td', { class: 'text-[12px]', text: destinoLabel }),
          el('td', { class: 'text-right font-mono text-[12px]', text: String(t.lot_count ?? s.lots.length) }),
          el('td', { class: 'text-right font-mono', text: fmtKg(t.kg_dried ?? 0) }),
          el('td', { class: 'text-right font-mono', text: fmtKg(t.kg_green ?? 0) }),
          el('td', { class: 'text-right font-mono text-[12px]', text: String(t.num_sacos || '—') }),
          el('td', { class: 'text-right font-mono text-[12px]', text: String(t.num_lonas || '—') }),
          el('td', { class: 'whitespace-nowrap text-right' }, [
            el('div', { class: 'inline-flex items-center gap-1' }, shipmentActions(s, 'xs')),
          ]),
        ]));

        if (isExp) {
          tbody.append(el('tr', { class: 'bg-cream' }, [
            el('td', { colspan: '10', class: 'p-3' }, [renderExpandedDetail(s)]),
          ]));
        }
      }

      // Totales
      const totalLots  = shown.reduce((sum, x) => sum + (x.totals?.lot_count || x.lots.length), 0);
      const totalSeco  = shown.reduce((sum, x) => sum + Number(x.totals?.kg_dried || 0), 0);
      const totalVerde = shown.reduce((sum, x) => sum + Number(x.totals?.kg_green || 0), 0);
      const totalSacos = shown.reduce((sum, x) => sum + Number(x.totals?.num_sacos || 0), 0);
      const totalLonas = shown.reduce((sum, x) => sum + Number(x.totals?.num_lonas || 0), 0);
      const tfoot = el('tfoot', {}, [el('tr', { class: 'border-t-2 border-ink-300 bg-cream' }, [
        el('td', { class: 'w-8' }, []),
        el('td', { class: 'font-display text-[11px] uppercase tracking-eyebrow text-ink-700',
          text: `Total · ${shown.length}` }),
        el('td', {}, []),
        el('td', {}, []),
        el('td', { class: 'text-right font-mono font-semibold text-navy', text: String(totalLots) }),
        el('td', { class: 'text-right font-mono font-semibold text-navy', text: fmtKg(totalSeco) }),
        el('td', { class: 'text-right font-mono font-semibold text-navy', text: fmtKg(totalVerde) }),
        el('td', { class: 'text-right font-mono font-semibold text-navy', text: String(totalSacos) }),
        el('td', { class: 'text-right font-mono font-semibold text-navy', text: String(totalLonas) }),
        el('td', {}, []),
      ])]);

      const table = el('table', { class: 'w-full text-[12px]' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { class: 'w-8' }, []),
          th('Código'),
          th('Fecha'),
          th('Destino'),
          th('Lotes', 'text-right'),
          th('kg seco', 'text-right'),
          th('kg verde esp.', 'text-right'),
          th('Sacos', 'text-right'),
          th('Lonas', 'text-right'),
          th('Acciones', 'text-right'),
        ])]),
        tbody,
        tfoot,
      ]);
      tableEl.append(table);
    }
    renderTableBody();
    wrap.append(searchInput, tableEl);
    return wrap;
  }

  function th(label, extra = '') {
    return el('th', { class: `text-left text-[10px] uppercase tracking-eyebrow text-ink-500 font-display ${extra}`, text: label });
  }

  // Sub-tabla por bache que aparece bajo cada fila expandida.
  function renderExpandedDetail(s) {
    const allRows = [];
    for (const lot of (s.lots || [])) {
      allRows.push(...lotSubRows(s, lot));
    }
    const subTable = el('table', { class: 'w-full text-[11px] bg-white border border-sand rounded-md overflow-hidden' }, [
      el('thead', {}, [el('tr', { class: 'bg-navy', style: 'color:#e7e244;' }, [
        el('th', { class: 'text-left px-3 py-2 uppercase tracking-eyebrow text-[10px]', text: 'Bache' }),
        el('th', { class: 'text-left px-3 py-2 uppercase tracking-eyebrow text-[10px]', text: 'Referencia' }),
        el('th', { class: 'text-left px-3 py-2 uppercase tracking-eyebrow text-[10px]', text: 'Proceso' }),
        el('th', { class: 'text-right px-3 py-2 uppercase tracking-eyebrow text-[10px]', text: 'kg seco' }),
        el('th', { class: 'text-right px-3 py-2 uppercase tracking-eyebrow text-[10px]', text: 'kg verde' }),
        el('th', { class: 'text-left px-3 py-2 uppercase tracking-eyebrow text-[10px]', text: 'Variedades' }),
        el('th', { class: 'text-left px-3 py-2 uppercase tracking-eyebrow text-[10px]', text: 'Empaque' }),
        el('th', { class: 'text-right px-3 py-2 uppercase tracking-eyebrow text-[10px]', text: 'Acciones' }),
      ])]),
      el('tbody', {}, allRows),
    ]);

    // Notas del despacho debajo (si las hay)
    const notesNode = s.notes
      ? el('p', { class: 'text-[11px] text-ink-500 italic mt-2', text: s.notes })
      : null;
    return el('div', { class: 'space-y-2' }, [subTable, notesNode]);
  }

  // Devuelve array de <tr> para un bache: fila base + (opcional)
  // parciales + (opcional) asignaciones. El padre (renderExpandedDetail)
  // las mete todas en un mismo <tbody>.
  function lotSubRows(s, lot) {
    const partials = lot.partials_in_shipment || [];
    const kgSeco = partials.length > 0
      ? partials.reduce((sum, p) => sum + Number(p.kg_dried || 0), 0)
      : Number(lot.kg_dried_shipped ?? lot.kg_dried_output ?? 0);
    const kgVerde = Number(lot.kg_green_in_shipment ?? lot.kg_green_actual ?? lot.kg_green_expected ?? 0);
    const varieties = (lot.varieties || []).map((v) => v.name).join(', ') || '—';
    const baseRow = el('tr', { class: 'border-t border-sand' }, [
      el('td', { class: 'px-3 py-2 font-mono font-semibold text-navy' }, [
        lot.is_blend ? el('span', { class: 'ctrm-pill text-[9px] mr-1', style: 'background:#e8efe3;color:#2e4a2e;', text: 'MZ' }) : null,
        el('button', {
          type: 'button',
          class: 'font-mono font-semibold text-navy hover:underline',
          style: 'background:none;border:none;padding:0;cursor:pointer;',
          title: 'Ver historial del bache',
          onClick: (e) => { e.stopPropagation(); navigate(`/finca/bache?id=${lot.id}`); },
          text: (lot.bache_code || lot.blend_code || lot.lot_code || '—') + (lot.split_label ? `-${lot.split_label}` : ''),
        }),
      ]),
      el('td', { class: 'px-3 py-2 text-ink-700', text: lot.reference_name || '—' }),
      el('td', { class: 'px-3 py-2 text-[11px]', text: lot.process_type || '—' }),
      el('td', { class: 'px-3 py-2 text-right font-mono', text: fmtKg(kgSeco) }),
      el('td', { class: 'px-3 py-2 text-right font-mono', text: fmtKg(kgVerde) }),
      el('td', { class: 'px-3 py-2 text-[11px] text-ink-500', text: varieties }),
      el('td', { class: 'px-3 py-2 text-[11px] text-ink-700 whitespace-nowrap' }, [
        lot.color_cinta
          ? el('span', {
              class: 'inline-block w-3 h-3 rounded-sm border border-ink-300 mr-1 align-middle',
              style: `background:${lot.color_cinta};`,
              title: `Cinta ${lot.color_cinta}`,
            })
          : null,
        el('span', { text: empaqueSummary(lot) }),
      ]),
      el('td', { class: 'px-3 py-2 text-right whitespace-nowrap' }, [
        el('div', { class: 'inline-flex items-center gap-1' }, [
          el('button', {
            class: 'ctrm-btn ctrm-btn-action ctrm-btn-xs',
            title: 'Asignar a un pedido o compra directa',
            onClick: (e) => { e.stopPropagation(); doAssign(lot); },
          }, ['+ Asignar']),
          el('button', {
            class: 'ctrm-btn ctrm-btn-danger ctrm-btn-xs',
            title: 'Cancelar esta línea del despacho',
            onClick: (e) => { e.stopPropagation(); cancelShipmentLine(s, lot); },
          }, ['× Cancelar línea']),
        ]),
      ]),
    ]);
    const rows = [baseRow];
    if (lot.observaciones) {
      rows.push(el('tr', {}, [
        el('td', { colspan: '8', class: 'px-3 pb-2 pt-0 text-[10px] text-ink-500 italic',
          text: `Obs.: ${lot.observaciones}` }),
      ]));
    }
    if (partials.length > 0) {
      rows.push(el('tr', { class: 'bg-cream' }, [
        el('td', { colspan: '8', class: 'px-3 py-2' }, [partialsInline(partials)]),
      ]));
    }
    if (lot.assignments && lot.assignments.length > 0) {
      rows.push(el('tr', { class: 'bg-cream' }, [
        el('td', { colspan: '8', class: 'px-3 py-2' }, [assignmentsInline(lot.assignments)]),
      ]));
    }
    return rows;
  }

  // "3 sacos · 2 lonas · Grain Pro" para una línea de despacho.
  function empaqueSummary(x) {
    const parts = [];
    if (Number(x.num_sacos)) parts.push(`${x.num_sacos} sacos`);
    if (Number(x.num_lonas)) parts.push(`${x.num_lonas} lonas`);
    if (x.empaque_interior === 'grainpro') parts.push('Grain Pro');
    else if (x.empaque_interior === 'bolsa') parts.push('Bolsa plást.');
    return parts.join(' · ') || '—';
  }

  function partialsInline(partials) {
    return el('div', { class: 'space-y-1' }, [
      el('p', { class: 'eyebrow text-[9px] text-ink-500', text: `Parciales (${partials.length})` }),
      el('table', { class: 'w-full text-[10px]' }, [
        el('thead', {}, [el('tr', { class: 'text-ink-300 uppercase tracking-loose' }, [
          el('th', { class: 'text-left px-2 py-1' }, ['Parcial']),
          el('th', { class: 'text-right px-2 py-1' }, ['kg seco']),
          el('th', { class: 'text-right px-2 py-1' }, ['Factor']),
          el('th', { class: 'text-right px-2 py-1' }, ['kg verde']),
        ])]),
        el('tbody', {}, partials.map((p) => el('tr', { class: 'border-t border-sand' }, [
          el('td', { class: 'px-2 py-1 font-mono', text: `P${p.parcial_letter}` }),
          el('td', { class: 'px-2 py-1 text-right font-mono', text: fmtKg(p.kg_dried) }),
          el('td', { class: 'px-2 py-1 text-right font-mono', text: String(p.factor_rendimiento || '—') }),
          el('td', { class: 'px-2 py-1 text-right font-mono', text: fmtKg(p.kg_green_yield) }),
        ]))),
      ]),
    ]);
  }

  function assignmentsInline(assignments) {
    return el('div', { class: 'space-y-1' }, [
      el('p', { class: 'eyebrow text-[9px] text-ink-500', text: `Asignaciones (${assignments.length})` }),
      el('table', { class: 'w-full text-[10px]' }, [
        el('thead', {}, [el('tr', { class: 'text-ink-300 uppercase tracking-loose' }, [
          el('th', { class: 'text-left px-2 py-1' }, ['Pedido']),
          el('th', { class: 'text-left px-2 py-1' }, ['Cliente']),
          el('th', { class: 'text-left px-2 py-1' }, ['Tipo']),
          el('th', { class: 'text-right px-2 py-1' }, ['kg verde']),
        ])]),
        el('tbody', {}, assignments.map((a) => {
          const o = a.order || {};
          return el('tr', { class: 'border-t border-sand' }, [
            el('td', { class: 'px-2 py-1' }, [
              o.id
                ? el('button', {
                    type: 'button',
                    class: 'font-mono text-navy font-semibold hover:underline',
                    style: 'background:none;border:none;padding:0;cursor:pointer;',
                    onClick: (e) => { e.stopPropagation(); navigate(`/pedido?id=${o.id}`); },
                    text: o.order_code || '—',
                  })
                : document.createTextNode(o.order_code || '—'),
            ]),
            el('td', { class: 'px-2 py-1', text: o.client_name || '—' }),
            el('td', { class: 'px-2 py-1', text: o.order_type || '—' }),
            el('td', { class: 'px-2 py-1 text-right font-mono font-bold', text: fmtKg(a.kg_green_allocated) }),
          ]);
        })),
      ]),
    ]);
  }

  async function doAssign(lot) {
    try {
      const out = await openAssignModal(lot);
      if (out && out.ok) {
        toast('Asignación registrada', 'success');
        await reload();
      }
    } catch (e) { toast(e.message || 'Error al asignar', 'error'); }
  }

  async function cancelShipmentLine(shipment, lot) {
    const reasonInput = el('textarea', {
      rows: '3', class: 'ctrm-textarea w-full',
      placeholder: 'Motivo de la cancelación de esta línea…',
    });
    const out = await openModal(({ close }) => el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-[12px] text-ink-700 leading-relaxed' }, [
        `Cancelar la línea del bache `,
        el('strong', { class: 'text-navy', text: lot.bache_code || lot.lot_code }),
        ` del despacho `,
        el('strong', { class: 'text-navy', text: shipment.shipment_code }),
        `. El bache vuelve a Listo y los pedidos completados que ya no cumplan vuelven a InProduction.`,
        lot.split_label
          ? el('span', { class: 'block mt-1 text-warn font-semibold',
              text: 'Este bache está dividido: se cancelan TODAS sus líneas P de este despacho.' })
          : null,
      ]),
      el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'Motivo *' }),
        reasonInput,
      ]),
      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { type: 'button', class: 'ctrm-btn ctrm-btn-ghost', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          type: 'button', class: 'ctrm-btn ctrm-btn-danger',
          onClick: () => {
            const reason = reasonInput.value.trim();
            if (!reason) { toast('Indica el motivo', 'warning'); return; }
            close({ reason });
          },
        }, ['Cancelar línea']),
      ]),
    ]), { title: 'Cancelar línea del despacho' });

    if (!out) return;
    try {
      const r = await api.shipmentLineCancel({
        shipment_id: shipment.id,
        production_lot_id: lot.id,
        reason: out.reason,
      });
      const c = r.cancelled || {};
      const parts = [`Línea cancelada`];
      if (c.lot_reverted_to_ready) parts.push('Bache → Listo');
      if (c.shipment_deleted) parts.push('Despacho borrado (sin más líneas)');
      if ((c.orders_reverted_to_in_production || []).length > 0) {
        parts.push(`${c.orders_reverted_to_in_production.length} pedido(s) → InProduction`);
      }
      toast(parts.join(' · '), 'success', 6000);
      await reload();
    } catch (e) { toast(e.message || 'Error al cancelar línea', 'error', 6000); }
  }

  render();
  focusFromQuery();

  return chrome(el('div', {}, [
    pageTitle('Despachos', 'Mezcla lotes Listos en un despacho y genera PDF'),
    el('div', { class: 'mb-4 flex items-center justify-between gap-2 flex-wrap' }, [
      el('p', { class: 'text-[12px] text-ink-500' },
        [`${readyLots.length} lote(s) Listos esperando despacho`]),
      el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
        vm.toggleEl,
        el('button', {
          class: 'ctrm-btn ctrm-btn-yellow uppercase tracking-eyebrow text-[11px] py-2.5 px-5',
          onClick: () => openCreateModal(),
        }, ['+ Nuevo despacho']),
      ]),
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
    const destinoLabel = s.destino_kind === 'Otro'
      ? `Otro${s.destino_other ? ': ' + s.destino_other : ''}`
      : (s.destino_kind || '—');

    const isDraft = s.status === 'draft';
    return el('div', {
      class: `ctrm-card ctrm-card-pad space-y-3 ${isDraft ? 'border-l-4' : ''}`,
      style: isDraft ? 'border-left-color:#b06216;' : '',
      'data-shipment-id': s.id,
    }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
          el('span', { class: 'ctrm-code', text: s.shipment_code }),
          el('span', { class: 'font-display font-semibold text-navy text-[13px]', text: fmtDate(s.shipment_date) }),
          isDraft
            ? el('span', { class: 'ctrm-pill', style: 'background:#f3e3cf;color:#8a5216;', text: '📋 Borrador' })
            : el('span', { class: 'ctrm-pill ok', text: 'Despachado' }),
        ]),
        el('div', { class: 'flex items-center gap-2 flex-wrap' }, shipmentActions(s, 'sm')),
      ]),
      // Meta strip alineado con las columnas de la vista Tabla:
      // Destino · Lotes · kg seco · kg verde esp. · Sacos · Lonas · Empaque
      el('div', { class: 'flex flex-wrap text-[12px] text-ink-500 gap-x-4 gap-y-1 font-mono' }, [
        meta('Destino',  destinoLabel),
        meta('Lotes',    String(t.lot_count ?? s.lots.length)),
        meta('kg seco',  fmtKg(t.kg_dried ?? 0)),
        meta('kg verde esp.', fmtKg(t.kg_green ?? 0)),
        meta('Sacos',    String(t.num_sacos || '—')),
        meta('Lonas',    String(t.num_lonas || '—')),
        (t.grainpro_count || t.bolsas_count)
          ? meta('Empaque', [
              t.grainpro_count ? `GP ${t.grainpro_count}` : null,
              t.bolsas_count ? `Bolsa ${t.bolsas_count}` : null,
            ].filter(Boolean).join(' · '))
          : null,
      ]),
      // Baches en dropdown colapsable. Por defecto cerrado para que
      // la card sea compacta en móvil; se expande al hacer click en
      // el summary "Ver baches (N)".
      el('details', { class: 'border-t border-sand pt-3' }, [
        el('summary', {
          class: 'cursor-pointer text-[11px] font-display uppercase tracking-eyebrow text-ink-500 hover:text-navy',
        }, [`Ver baches (${s.lots.length})`]),
        el('div', { class: 'space-y-3 mt-3' }, s.lots.map((lot) => lotBlock(s, lot))),
      ]),
      s.notes
        ? el('p', { class: 'text-[11px] text-ink-500 italic border-t border-sand pt-2', text: s.notes })
        : null,
    ]);
  }

  // Bloque por bache en la card. Muestra los MISMOS campos que la
  // sub-tabla del dropdown de la vista Tabla (kg seco realmente
  // despachado + kg verde en este shipment) + acciones idénticas
  // (+ Asignar, × Cancelar línea).
  function lotBlock(s, lot) {
    const partials = lot.partials_in_shipment || [];
    // kg seco realmente despachado en ESTE shipment (no el total del
    // bache). Para partials = suma de cada uno; para whole/by-kg =
    // kg_dried_shipped que viene de shipments-list.
    const kgSecoShipped = partials.length > 0
      ? partials.reduce((sum, p) => sum + Number(p.kg_dried || 0), 0)
      : Number(lot.kg_dried_shipped ?? lot.kg_dried_output ?? 0);
    const kgVerdeShipped = Number(lot.kg_green_in_shipment ?? lot.kg_green_actual ?? lot.kg_green_expected ?? 0);

    return el('div', { class: 'rounded-md border border-sand bg-white overflow-hidden' }, [
      // Lot header (navy strip, igual al PDF)
      el('div', { class: 'flex items-center justify-between gap-2 px-3 py-2', style: 'background:#1a3a5c;' }, [
        el('div', { class: 'flex items-center gap-2 min-w-0' }, [
          el('button', {
            type: 'button',
            class: 'font-mono font-bold text-[12px] hover:underline',
            style: 'background:none;border:none;padding:0;cursor:pointer;color:#e7e244;',
            title: 'Ver historial del bache',
            onClick: (e) => { e.stopPropagation(); navigate(`/finca/bache?id=${lot.id}`); },
            text: (lot.bache_code || lot.lot_code) + (lot.split_label ? `-${lot.split_label}` : ''),
          }),
          el('span', { class: 'font-display font-semibold text-[12px] truncate', style: 'color:#fff;', text: lot.reference_name || '—' }),
        ]),
        el('span', { class: 'font-mono text-[11px]', style: 'color:#cdd5dd;', text: `${lot.process_type} · ${fmtKg(kgVerdeShipped)}` }),
      ]),
      // Meta strip alineado con sub-tabla del dropdown:
      // Proceso · kg seco · kg verde · Variedades
      el('div', { class: 'px-3 py-2 text-[11px] text-ink-500 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-sand' }, [
        el('span', {}, [`Proceso: `, el('strong', { class: 'text-ink-700', text: lot.process_type || '—' })]),
        el('span', {}, [`kg seco: `, el('strong', { class: 'text-ink-700', text: fmtKg(kgSecoShipped) })]),
        el('span', {}, [`kg verde: `, el('strong', { class: 'text-ink-700', text: fmtKg(kgVerdeShipped) })]),
        lot.varieties && lot.varieties.length
          ? el('span', {}, [`Variedades: `, el('strong', { class: 'text-ink-700', text: lot.varieties.map((v) => v.name).join(', ') })])
          : null,
        el('span', {}, [
          `Empaque: `,
          lot.color_cinta
            ? el('span', {
                class: 'inline-block w-3 h-3 rounded-sm border border-ink-300 mr-1 align-middle',
                style: `background:${lot.color_cinta};`,
                title: `Cinta ${lot.color_cinta}`,
              })
            : null,
          el('strong', { class: 'text-ink-700', text: empaqueSummary(lot) }),
        ]),
        lot.observaciones
          ? el('span', { class: 'italic', text: `Obs.: ${lot.observaciones}` })
          : null,
        // Acciones por bache (mismas de la sub-tabla del dropdown)
        el('span', { class: 'ml-auto flex items-center gap-1' }, [
          el('button', {
            class: 'ctrm-btn ctrm-btn-action ctrm-btn-xs',
            title: 'Asignar a un pedido o compra directa',
            onClick: () => doAssign(lot),
          }, ['+ Asignar']),
          el('button', {
            class: 'ctrm-btn ctrm-btn-danger ctrm-btn-xs',
            title: 'Cancelar esta línea del despacho',
            onClick: () => cancelShipmentLine(s, lot),
          }, ['× Cancelar línea']),
        ]),
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
                const codeBtn = o.id
                  ? el('button', {
                      type: 'button',
                      class: 'font-mono text-navy font-semibold hover:underline',
                      style: 'background:none;border:none;padding:0;cursor:pointer;',
                      onClick: () => navigate(`/pedido?id=${o.id}`),
                      text: o.order_code || '—',
                    })
                  : (o.order_code || '—');
                return [
                  codeBtn,
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
          r.map((cell, i) => el('td', { class: `px-2 py-1 ${cellClasses[i] || ''} text-ink-700` },
            [cell instanceof Node ? cell : document.createTextNode(String(cell))]))))),
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
  function downloadPrepPdf(shipment) {
    try {
      generateShipmentPrepPdf(shipment);
    } catch (e) { toast(e.message, 'error'); }
  }

  function draftChip() {
    return el('span', {
      class: 'ctrm-pill ml-1 text-[9px]',
      style: 'background:#f3e3cf;color:#8a5216;', text: '📋 Borrador',
    });
  }

  // Acciones de una fila/card de despacho, según sea borrador o
  // definitivo. size: 'xs' (tabla) | 'sm' (card).
  function shipmentActions(s, size) {
    const cls = `ctrm-btn ctrm-btn-${size}`;
    const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
    if (s.status === 'draft') {
      return [
        el('button', { class: `${cls} ctrm-btn-soft`, title: 'Hoja de preparación para bodega (borrador)',
          onClick: stop(() => downloadPrepPdf(s)) }, ['↓ Preparación']),
        el('button', { class: `${cls} ctrm-btn-action`, title: 'Completar la info y confirmar como despacho definitivo',
          onClick: stop(() => completeDraftModal(s)) }, ['✓ Completar / Confirmar']),
        el('button', { class: `${cls} ctrm-btn-danger`, title: 'Descartar borrador · libera el inventario apartado',
          onClick: stop(() => discardDraft(s)) }, ['× Descartar']),
      ];
    }
    return [
      el('button', { class: `${cls} ctrm-btn-soft`, title: 'Remisión para la trilladora',
        onClick: stop(() => downloadPdf(s)) }, ['↓ Remisión']),
      el('button', { class: `${cls} ctrm-btn-soft`, title: 'Documento interno · asignaciones',
        onClick: stop(() => downloadAssignmentsPdf(s)) }, [size === 'xs' ? '↓ Asign.' : '↓ Asignaciones']),
      el('button', { class: `${cls} ctrm-btn-danger`, title: 'Cancelar despacho completo',
        onClick: stop(() => cancelShipment(s)) }, ['× Cancelar']),
    ];
  }

  // Modal para completar la logística de un borrador y (opcional)
  // confirmarlo. NO cambia baches/kg — solo destino, conductor y los
  // datos de empaque por bache que suelen ir incompletos.
  function completeDraftModal(shipment) {
    return openModal(({ close }) => {
      const header = {
        shipment_date: shipment.shipment_date,
        destino_kind: shipment.destino_kind || '',
        destino_other: shipment.destino_other || '',
        driver_cedula: shipment.driver_cedula || '',
        driver_name: shipment.driver_name || '',
        driver_placas: shipment.driver_placas || '',
        notes: shipment.notes || '',
      };
      // Disponible por bache (excluye el apartado de ESTE borrador,
      // sumándolo de vuelta) para validar el kg que se ingresa.
      const readyById = new Map(readyLots.map((l) => [l.id, l]));

      // Estado editable por bache (grupo). El kg solo es editable en
      // líneas whole/by-kg (una sola línea); en despachos por parciales
      // el kg lo fija cada parcial y va de solo lectura.
      const groupState = (shipment.lots || []).map((g) => {
        const ids = g.shipment_lot_ids || [];
        const partials = g.partials_in_shipment || [];
        const editableKg = g.whole_lot_in_shipment === true && ids.length === 1;
        const currentKg = editableKg
          ? Number(g.kg_dried_shipped ?? g.kg_dried_output ?? 0)
          : partials.reduce((s, p) => s + Number(p.kg_dried || 0), 0);
        const availLot = Number(readyById.get(g.id)?.kg_dried_available || 0);
        return {
          ids,
          lineId: editableKg ? ids[0] : null,
          code: (g.bache_code || g.blend_code || g.lot_code || '—') + (g.split_label ? `-${g.split_label}` : ''),
          ref: g.reference_name || '—',
          editableKg,
          kg: currentKg,
          // Techo: lo disponible del bache (ya descuenta este borrador)
          // + lo que este borrador tenía apartado en esta línea.
          maxKg: editableKg ? Math.round((availLot + currentKg) * 100) / 100 : currentKg,
          codigo_trilladora: g.codigo_trilladora || '',
          codigo_mezcla: g.codigo_mezcla || '',
          num_sacos: g.num_sacos ?? '',
          num_lonas: g.num_lonas ?? '',
          empaque_interior: g.empaque_interior || '',
          color_cinta: g.color_cinta || '',
          observaciones: g.observaciones || '',
        };
      });

      const dateIn = el('input', { type: 'date', class: 'ctrm-input', value: header.shipment_date });
      const destinoSel = el('select', { class: 'ctrm-input' }, [
        el('option', { value: '' }, ['— Sin especificar —']),
        ...['Vertical', 'Tribox', 'Trillanova', 'Otro'].map((d) =>
          el('option', { value: d, selected: header.destino_kind === d }, [d])),
      ]);
      const destinoOther = el('input', { type: 'text', class: 'ctrm-input', placeholder: 'Especificar destino', value: header.destino_other });
      destinoOther.style.display = header.destino_kind === 'Otro' ? '' : 'none';
      destinoSel.addEventListener('change', () => { destinoOther.style.display = destinoSel.value === 'Otro' ? '' : 'none'; });
      const ccIn = el('input', { type: 'text', class: 'ctrm-input', placeholder: 'CC conductor', value: header.driver_cedula });
      const nameIn = el('input', { type: 'text', class: 'ctrm-input', placeholder: 'Nombre conductor', value: header.driver_name });
      const placasIn = el('input', { type: 'text', class: 'ctrm-input mono', placeholder: 'Placas', value: header.driver_placas });
      const notesIn = el('textarea', { rows: '2', class: 'ctrm-textarea', value: header.notes });

      const numIn = (st, field) => {
        const inp = el('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*',
          class: 'ctrm-input mono text-[11px] text-right w-16', value: st[field] === '' ? '' : String(st[field]) });
        inp.addEventListener('input', () => {
          const c = (inp.value || '').replace(/[^0-9]/g, '');
          if (c !== inp.value) inp.value = c;
          st[field] = c === '' ? '' : Number(c);
        });
        return inp;
      };
      const rows = groupState.map((st) => {
        const codT = el('input', { type: 'text', class: 'ctrm-input mono text-[11px] w-24', placeholder: 'PP-XXXX', value: st.codigo_trilladora });
        codT.addEventListener('input', () => { st.codigo_trilladora = codT.value; });
        const codM = el('input', { type: 'text', class: 'ctrm-input mono text-[11px] w-20', placeholder: '—', value: st.codigo_mezcla });
        codM.addEventListener('input', () => { st.codigo_mezcla = codM.value; });
        const empSel = el('select', { class: 'ctrm-input text-[10px] w-24' }, [
          el('option', { value: '', selected: !st.empaque_interior }, ['Ninguno']),
          el('option', { value: 'grainpro', selected: st.empaque_interior === 'grainpro' }, ['Grain Pro']),
          el('option', { value: 'bolsa', selected: st.empaque_interior === 'bolsa' }, ['Bolsa plást.']),
        ]);
        empSel.addEventListener('change', () => { st.empaque_interior = empSel.value; });
        const colorIn = el('input', { type: 'color', value: st.color_cinta || '#ffffff',
          class: 'cursor-pointer', style: 'width:26px;height:22px;border:1px solid #d8d8d0;border-radius:4px;padding:0;background:none;' });
        colorIn.addEventListener('input', () => { st.color_cinta = colorIn.value; });
        const colorClear = el('button', { type: 'button', class: 'text-ink-300 text-[12px]',
          style: 'background:none;border:none;padding:0 2px;cursor:pointer;', title: 'Quitar color',
          onClick: () => { st.color_cinta = ''; colorIn.value = '#ffffff'; } }, ['×']);
        const obsIn = el('input', { type: 'text', class: 'ctrm-input text-[11px] w-32', maxlength: '200', placeholder: 'Observaciones', value: st.observaciones });
        obsIn.addEventListener('input', () => { st.observaciones = obsIn.value; });
        // Celda de kg: editable en whole/by-kg, solo lectura en parciales.
        let kgCell;
        if (st.editableKg) {
          const kgIn = el('input', {
            type: 'number', step: '0.01', min: '0.01', max: String(st.maxKg),
            class: 'ctrm-input mono text-[11px] text-right w-20',
            value: st.kg ? String(st.kg) : '',
          });
          const hint = el('div', { class: 'text-[9px] text-ink-300 mono', text: `máx ${fmtKg(st.maxKg)}` });
          kgIn.addEventListener('input', () => {
            st.kg = kgIn.value === '' ? '' : Number(kgIn.value);
            const over = st.kg !== '' && Number(st.kg) > st.maxKg + 0.01;
            kgIn.style.borderColor = over ? '#c0392b' : '';
            hint.textContent = over ? `supera el disponible (máx ${fmtKg(st.maxKg)})` : `máx ${fmtKg(st.maxKg)}`;
            hint.className = over ? 'text-[9px] text-crit mono' : 'text-[9px] text-ink-300 mono';
          });
          kgCell = el('div', { class: 'flex flex-col items-end gap-0.5' }, [kgIn, hint]);
        } else {
          kgCell = el('div', { class: 'text-right' }, [
            el('span', { class: 'font-mono text-[11px] text-ink-700', text: fmtKg(st.kg) }),
            el('div', { class: 'text-[9px] text-ink-300', text: 'por parciales' }),
          ]);
        }
        return el('tr', { class: 'border-b border-sand' }, [
          el('td', { class: 'px-2 py-1.5 font-mono font-semibold text-navy text-[11px]' }, [st.code]),
          el('td', { class: 'px-2 py-1.5 text-[11px] text-ink-500' }, [st.ref]),
          el('td', { class: 'px-2 py-1.5' }, [codT]),
          el('td', { class: 'px-2 py-1.5' }, [codM]),
          el('td', { class: 'px-2 py-1.5' }, [kgCell]),
          el('td', { class: 'px-2 py-1.5 text-right' }, [numIn(st, 'num_sacos')]),
          el('td', { class: 'px-2 py-1.5 text-right' }, [numIn(st, 'num_lonas')]),
          el('td', { class: 'px-2 py-1.5' }, [empSel]),
          el('td', { class: 'px-2 py-1.5' }, [el('div', { class: 'flex items-center gap-0.5' }, [colorIn, colorClear])]),
          el('td', { class: 'px-2 py-1.5' }, [obsIn]),
        ]);
      });

      // Valida que cada kg editado sea > 0 y no supere el disponible.
      function validateKg() {
        for (const st of groupState) {
          if (!st.editableKg) continue;
          const kg = Number(st.kg);
          if (!(kg > 0)) { toast(`${st.code}: ingresa los kg a despachar`, 'warning'); return false; }
          if (kg > st.maxKg + 0.01) {
            toast(`${st.code}: ${fmtKg(kg)} kg supera el disponible (máx ${fmtKg(st.maxKg)})`, 'warning'); return false;
          }
        }
        return true;
      }

      function buildPatch() {
        const lines = [];
        for (const st of groupState) {
          const vals = {
            codigo_trilladora: st.codigo_trilladora.trim() || null,
            codigo_mezcla: st.codigo_mezcla.trim() || null,
            num_sacos: st.num_sacos === '' ? null : Number(st.num_sacos),
            num_lonas: st.num_lonas === '' ? null : Number(st.num_lonas),
            empaque_interior: st.empaque_interior || null,
            color_cinta: st.color_cinta || null,
            observaciones: st.observaciones.trim() || null,
          };
          // kg solo en líneas whole/by-kg (una sola línea).
          if (st.editableKg && st.kg !== '' && st.lineId) {
            vals.kg_dried_shipped = Number(st.kg);
          }
          for (const id of st.ids) lines.push({ id, ...vals });
        }
        return {
          header: {
            shipment_date: dateIn.value,
            destino_kind: destinoSel.value || null,
            destino_other: destinoSel.value === 'Otro' ? destinoOther.value.trim() : null,
            driver_cedula: ccIn.value.trim() || null,
            driver_name: nameIn.value.trim() || null,
            driver_placas: placasIn.value.trim() || null,
            notes: notesIn.value.trim() || null,
          },
          lines,
        };
      }

      const saveBtn = el('button', { class: 'ctrm-btn ctrm-btn-soft', type: 'button' }, ['Guardar borrador']);
      const confirmBtn = el('button', { class: 'ctrm-btn ctrm-btn-primary', type: 'button' }, ['✓ Confirmar despacho']);
      saveBtn.addEventListener('click', async () => {
        if (saveBtn.disabled) return;
        if (!validateKg()) return;
        saveBtn.disabled = true; saveBtn.textContent = 'Guardando…';
        try {
          await api.shipmentsUpdate({ shipment_id: shipment.id, ...buildPatch() });
          toast(`Borrador ${shipment.shipment_code} actualizado`, 'success');
          close({ ok: true }); await reload();
        } catch (e) { toast(e.message, 'error'); saveBtn.disabled = false; saveBtn.textContent = 'Guardar borrador'; }
      });
      confirmBtn.addEventListener('click', async () => {
        if (confirmBtn.disabled) return;
        if (!validateKg()) return;
        if (destinoSel.value === 'Otro' && !destinoOther.value.trim()) { toast('Especifica el destino "Otro"', 'warning'); return; }
        const ok = await confirmModal(
          `Confirmar ${shipment.shipment_code} como despacho definitivo. Los baches pasan a Despachado ` +
          `y los pedidos asignados podrán completarse. ¿Continuar?`,
          { title: 'Confirmar despacho' });
        if (!ok) return;
        confirmBtn.disabled = true; confirmBtn.textContent = 'Confirmando…';
        try {
          const r = await api.shipmentsConfirm({ shipment_id: shipment.id, ...buildPatch() });
          const compl = (r.completions || []).length;
          toast(`Despacho ${shipment.shipment_code} confirmado${compl ? ` · ${compl} pedido(s) completado(s)` : ''}`, 'success', 4500);
          close({ ok: true }); await reload();
        } catch (e) {
          toast(e.message, 'error'); confirmBtn.disabled = false; confirmBtn.textContent = '✓ Confirmar despacho';
        }
      });

      return el('div', { class: 'space-y-3' }, [
        el('p', { class: 'text-[12px] text-ink-500', text: 'Completa la logística y ajusta los kg a despachar (bodega los pesa al alistar). Para cambiar qué baches entran, descarta y crea de nuevo.' }),
        el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-3' }, [
          labelled('Fecha', dateIn),
          labelled('Destino', destinoSel),
        ]),
        destinoSel.value === 'Otro' ? labelled('Especificar destino', destinoOther) : destinoOther,
        el('div', { class: 'grid grid-cols-1 sm:grid-cols-3 gap-2' }, [
          labelled('Conductor — CC', ccIn),
          labelled('Conductor — Nombre', nameIn),
          labelled('Placas', placasIn),
        ]),
        labelled('Notas', notesIn),
        el('div', { class: 'overflow-x-auto border border-sand rounded-md' }, [
          el('table', { class: 'w-full text-[12px]' }, [
            el('thead', {}, [el('tr', { class: 'bg-navy text-yellow' },
              ['Bache', 'Ref', 'Cód. Trilladora', 'Cód. Mezcla', 'kg a despachar', 'Sacos', 'Lonas', 'Empaque', 'Color', 'Observaciones']
                .map((h) => el('th', { class: 'px-2 py-2 text-left uppercase tracking-eyebrow text-[9px]' }, [h])))]),
            el('tbody', {}, rows),
          ]),
        ]),
        el('div', { class: 'flex flex-wrap justify-end gap-2 pt-3 border-t border-sand' }, [
          el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cerrar']),
          saveBtn, confirmBtn,
        ]),
      ]);
    }, { title: `Completar borrador · ${shipment.shipment_code}`, size: 'xl' });
  }

  async function discardDraft(shipment) {
    const ok = await confirmModal(
      `¿Descartar el borrador ${shipment.shipment_code}? Se libera el inventario apartado ` +
      `(${fmtKg(shipment.totals?.kg_dried ?? 0)} kg) y no queda registro de despacho.`,
      { title: 'Descartar borrador', confirmText: 'Descartar', danger: true },
    );
    if (!ok) return;
    try {
      // shipments-cancel borra las líneas; como el borrador nunca marcó
      // baches Delivered, no hay nada que revertir.
      await api.shipmentsCancel({ shipment_id: shipment.id });
      toast(`Borrador ${shipment.shipment_code} descartado · inventario liberado`, 'success', 4500);
      await reload();
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
      title: 'Nuevo despacho', size: 'xl',
    });
  }

  function createModalBody(close, preselectLotIds) {
    // ── Estado de selección ──────────────────────────────────────
    //   selectedLots:   Set<lot_id>     baches que entran al despacho
    //   partialIds:     Set<partial_id> partials seleccionados (auto
    //                   para mezclados; manual para separados)
    //   lotFields:      Map<lot_id, {codigo_trilladora, codigo_mezcla,
    //                   num_sacos, partials_merged, kg_mode, kg_dried_to_ship}>
    //   partialFields:  Map<partial_id, {codigo_trilladora, codigo_mezcla, num_sacos}>
    const selectedLots = new Set(Array.isArray(preselectLotIds) ? preselectLotIds : []);
    const partialIds = new Set();
    const lotFields = new Map();
    const partialFields = new Map();
    const readyLotsById = new Map(readyLots.map((l) => [l.id, l]));

    function getLotFields(lotId) {
      if (!lotFields.has(lotId)) {
        lotFields.set(lotId, {
          codigo_trilladora: '', codigo_mezcla: '', num_sacos: '',
          num_lonas: '', empaque_interior: '', color_cinta: '', observaciones: '',
          partials_merged: true, kg_mode: 'todo', kg_dried_to_ship: '',
          // kg_real: peso de báscula en modo Todo ('' = igual al registrado)
          // splits: null | [{...campos por línea + kg_dried_to_ship}] (división P1/P2)
          kg_real: '', splits: null,
        });
      }
      return lotFields.get(lotId);
    }
    function getPartialFields(pid) {
      if (!partialFields.has(pid)) {
        partialFields.set(pid, { codigo_trilladora: '', codigo_mezcla: '', num_sacos: '' });
      }
      return partialFields.get(pid);
    }
    function eligPartials(l) {
      return (l.partials || []).filter((p) => !p.shipment_id && !p.rejected_at);
    }
    function autoSelectPartials(lotId) {
      const l = readyLotsById.get(lotId);
      if (!l) return;
      eligPartials(l).forEach((p) => partialIds.add(p.id));
    }
    function deselectAllPartials(lotId) {
      const l = readyLotsById.get(lotId);
      if (!l) return;
      (l.partials || []).forEach((p) => partialIds.delete(p.id));
    }
    // Inicializar parciales para preselección
    for (const lid of selectedLots) autoSelectPartials(lid);

    // ── Campos a nivel de remisión ──────────────────────────────
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
    function selectedKgVerde() {
      let total = 0;
      for (const lid of selectedLots) {
        const l = readyLotsById.get(lid);
        if (!l) continue;
        const partials = l.partials || [];
        if (partials.length === 0) total += Number(l.kg_green_actual ?? l.kg_green_expected ?? 0);
        else for (const p of partials) if (partialIds.has(p.id)) total += Number(p.kg_green_yield || 0);
      }
      return total;
    }
    function recountSummary() {
      clear(counter);
      const orderIds = new Set();
      for (const lid of selectedLots) {
        const l = readyLotsById.get(lid);
        (l && l.assignments || []).forEach((a) => orderIds.add(a.demand_order_id));
      }
      counter.append(
        infoChip('Baches', String(selectedLots.size)),
        infoChip('kg verde', fmtKg(selectedKgVerde())),
        infoChip('Pedidos involucrados', String(orderIds.size)),
      );
    }

    // ── Selector + Agregar bache ──────────────────────────────
    const addLotSelect = el('select', { class: 'ctrm-input text-[12px] flex-1' });
    function refreshAddLotOptions() {
      clear(addLotSelect);
      addLotSelect.append(el('option', { value: '' }, ['+ Agregar bache…']));
      readyLots
        .filter((l) => !selectedLots.has(l.id))
        .forEach((l) => {
          const code = l.bache_code || l.blend_code || l.lot_code;
          const ref = l.reference_name || '—';
          addLotSelect.append(el('option', { value: l.id }, [
            `${code} · ${ref} · ${l.process_type}`,
          ]));
        });
    }
    addLotSelect.addEventListener('change', () => {
      if (addLotSelect.value) {
        selectedLots.add(addLotSelect.value);
        autoSelectPartials(addLotSelect.value);
        addLotSelect.value = '';
        refreshAddLotOptions();
        renderTable();
        recountSummary();
      }
    });
    refreshAddLotOptions();

    // ── Tabla editable ────────────────────────────────────────
    const tableEl = el('div', { class: 'overflow-x-auto border border-sand rounded-md' });

    function renderKgCell(lf, avail, opts) {
      opts = opts || {};
      const isTodo = lf.kg_mode === 'todo';
      const segBtn = (label, active, onClick) => el('button', {
        type: 'button',
        class: `px-2 py-1 text-[9px] font-semibold uppercase tracking-eyebrow ${
          active ? 'bg-navy text-white' : 'bg-white text-ink-500'}`,
        onClick,
      }, [label]);
      const seg = el('div', { class: 'inline-flex border border-sand rounded overflow-hidden' }, [
        segBtn('Todo', isTodo, () => { lf.kg_mode = 'todo'; lf.kg_dried_to_ship = ''; lf.kg_real = ''; renderTable(); }),
        segBtn('Parcial', !isTodo, () => { lf.kg_mode = 'parcial'; lf.kg_dried_to_ship = String(avail); lf.kg_real = ''; renderTable(); }),
      ]);
      if (isTodo) {
        // Lotes con parciales: el kg es la suma de los parciales, no
        // editable. Lotes sin parciales: peso real de báscula editable
        // (si difiere del registrado, el bache cierra igual y la
        // diferencia queda como merma/ganancia de humedad).
        if (opts.hasPartials) {
          return el('div', { class: 'flex items-center justify-end gap-2' }, [
            seg,
            el('span', { class: 'text-ok font-mono font-bold text-[12px]', text: `${fmtKg(avail)}` }),
          ]);
        }
        const diffLabel = el('span', { class: 'text-[9px] text-warn font-mono mt-0.5' });
        const kgIn = el('input', {
          type: 'number', step: '0.01', min: '0.01',
          value: lf.kg_real !== '' ? lf.kg_real : String(avail),
          class: 'ctrm-input mono text-right text-[11px] w-20',
          title: 'Peso real de báscula — si difiere del registrado, el bache cierra igual y la diferencia queda como merma/ganancia de humedad',
        });
        const updateDiff = () => {
          const v = Number(kgIn.value || 0);
          const d = Math.round((v - avail) * 100) / 100;
          diffLabel.textContent = Math.abs(d) >= 0.01
            ? `${d > 0 ? '+' : ''}${d} kg vs registrado · cierra el bache`
            : '';
        };
        kgIn.addEventListener('input', () => { lf.kg_real = kgIn.value; updateDiff(); });
        updateDiff();
        return el('div', { class: 'flex flex-col items-end gap-0.5' }, [
          el('div', { class: 'flex items-center gap-1' }, [seg, kgIn]),
          diffLabel,
        ]);
      }
      const remainingLabel = el('span', { class: 'text-[9px] text-warn font-mono mt-0.5' });
      const kgIn = el('input', {
        type: 'number', step: '0.01', min: '0.01', max: String(avail),
        value: lf.kg_dried_to_ship || '',
        class: 'ctrm-input mono text-right text-[11px] w-20',
        style: 'border-color:#e65100;',
      });
      const updateRemaining = () => {
        const used = Number(kgIn.value || 0);
        const remaining = Math.max(0, avail - used);
        remainingLabel.textContent = remaining > 0.01 ? `${fmtKg(remaining)} kg quedan en bodega` : '';
      };
      kgIn.addEventListener('input', () => { lf.kg_dried_to_ship = kgIn.value; updateRemaining(); });
      updateRemaining();
      return el('div', { class: 'flex flex-col items-end gap-0.5' }, [
        el('div', { class: 'flex items-center gap-1' }, [seg, kgIn]),
        remainingLabel,
      ]);
    }

    function renderLotRow(idx, l, lf, avail, opts) {
      opts = opts || {};
      const priorMax = maxSplitP(l);
      const codeNode = el('span', { class: 'font-mono font-semibold text-navy text-[12px]' }, [
        l.is_blend ? el('span', { class: 'ctrm-pill text-[9px] mr-1', style: 'background:#e8efe3;color:#2e4a2e;', text: 'MZ' }) : null,
        l.parent_lot_id ? el('span', { class: 'ctrm-pill text-[9px] mr-1', style: 'background:#e0e7f5;color:#1b2044;', text: 'SUB' }) : null,
        document.createTextNode(l.bache_code || l.blend_code || l.lot_code),
        // El bache ya tiene divisiones despachadas: esta línea seguirá
        // la numeración automáticamente.
        priorMax > 0 ? el('span', { class: 'ctrm-pill text-[9px] ml-1', style: 'background:#f3e8d2;color:#7a5a1e;',
          title: 'El bache ya tiene divisiones despachadas; esta línea continúa la numeración',
          text: `→ P${priorMax + 1}` }) : null,
      ]);
      // División P1/P2: solo lotes sin parciales de producción.
      const divideBtn = !opts.hasPartials ? el('button', {
        type: 'button',
        class: 'block text-[10px] text-navy hover:underline mt-0.5',
        style: 'background:none;border:none;padding:0;cursor:pointer;',
        title: 'Dividir el bache en líneas P con su propio kg y empaque',
        onClick: () => {
          lf.splits = [
            makeSplitFields(lf),   // la primera hereda lo ya digitado
            makeSplitFields(),
          ];
          renderTable();
        },
      }, ['÷ Dividir']) : null;
      const refProcCell = el('div', {}, [
        el('div', { class: 'text-[11px] text-ink-700' }, [
          el('span', { text: l.reference_name || '—' }),
          el('span', { class: 'ctrm-pill ml-1 text-[9px]', style: 'background:#dde7ee;color:#1a3a5c;', text: l.process_type }),
        ]),
        opts.hasPartials ? el('label', { class: 'inline-flex items-center gap-1 cursor-pointer mt-1 text-[10px] text-ink-500' }, [
          el('input', { type: 'checkbox', class: 'h-3 w-3 accent-navy',
            checked: lf.partials_merged ? 'true' : null,
            onChange: (e) => {
              lf.partials_merged = e.target.checked;
              if (lf.partials_merged) autoSelectPartials(l.id);
              renderTable();
            },
          }),
          el('span', {}, [`Mezclar parciales (${opts.partialsCount})`]),
        ]) : null,
      ]);
      const codTIn = el('input', { type: 'text', class: 'ctrm-input mono text-[11px] w-28',
        placeholder: 'PP-XXXX', value: lf.codigo_trilladora || '' });
      codTIn.addEventListener('input', () => { lf.codigo_trilladora = codTIn.value; });
      const codMIn = el('input', { type: 'text', class: 'ctrm-input mono text-[11px] w-24',
        placeholder: '—', value: lf.codigo_mezcla || '' });
      codMIn.addEventListener('input', () => { lf.codigo_mezcla = codMIn.value; });
      const numIn = (field, width = 'w-14') => {
        const inp = el('input', {
          type: 'text', inputmode: 'numeric', pattern: '[0-9]*',
          class: `ctrm-input mono text-[11px] text-right ${width}`, value: lf[field] || '',
        });
        inp.addEventListener('input', () => {
          // Solo dígitos: descarta cualquier otro caracter
          const cleaned = (inp.value || '').replace(/[^0-9]/g, '');
          if (cleaned !== inp.value) inp.value = cleaned;
          lf[field] = cleaned === '' ? '' : Number(cleaned);
          recountSummary();
        });
        return inp;
      };
      const sacosIn = numIn('num_sacos');
      const lonasIn = numIn('num_lonas');

      // Empaque interior: una sola opción por lote (GP o bolsa).
      const empaqueSel = el('select', { class: 'ctrm-input text-[10px] w-24' }, [
        el('option', { value: '', selected: !lf.empaque_interior }, ['Ninguno']),
        el('option', { value: 'grainpro', selected: lf.empaque_interior === 'grainpro' }, ['Grain Pro']),
        el('option', { value: 'bolsa', selected: lf.empaque_interior === 'bolsa' }, ['Bolsa plást.']),
      ]);
      empaqueSel.addEventListener('change', () => { lf.empaque_interior = empaqueSel.value; recountSummary(); });

      // Color de cinta: input nativo (se abre al click, gana espacio) +
      // × para quitarlo. La fila se pinta en vivo para previsualizar
      // cómo saldrá en la remisión.
      const colorIn = el('input', {
        type: 'color', value: lf.color_cinta || '#ffffff',
        class: 'cursor-pointer', style: 'width:26px;height:22px;border:1px solid #d8d8d0;border-radius:4px;padding:0;background:none;',
        title: 'Color de cinta del lote — pinta la fila en la remisión',
      });
      const paintRow = () => {
        tr.style.background = lf.color_cinta ? hexToRgba(lf.color_cinta, 0.35) : '';
      };
      colorIn.addEventListener('input', () => { lf.color_cinta = colorIn.value; paintRow(); });
      const colorClear = el('button', {
        type: 'button', class: 'text-ink-300 text-[12px] hover:text-crit',
        style: 'background:none;border:none;padding:0 2px;cursor:pointer;',
        title: 'Quitar color',
        onClick: () => { lf.color_cinta = ''; colorIn.value = '#ffffff'; paintRow(); },
      }, ['×']);
      const colorCell = el('div', { class: 'flex items-center gap-0.5' }, [colorIn, colorClear]);

      const obsIn = el('input', { type: 'text', class: 'ctrm-input text-[11px] w-32',
        placeholder: 'Observaciones', maxlength: '200', value: lf.observaciones || '' });
      obsIn.addEventListener('input', () => { lf.observaciones = obsIn.value; });

      const removeBtn = el('button', { type: 'button',
        class: 'text-crit text-[16px] font-bold hover:bg-crit-bg rounded px-1',
        title: 'Quitar del despacho',
        onClick: () => {
          selectedLots.delete(l.id);
          deselectAllPartials(l.id);
          lotFields.delete(l.id);
          refreshAddLotOptions();
          renderTable();
          recountSummary();
        },
      }, ['×']);
      const tr = el('tr', { class: 'border-b border-sand hover:bg-cream/40' }, [
        el('td', { class: 'px-2 py-2 text-ink-300 text-[11px] font-mono', text: String(idx) }),
        el('td', { class: 'px-2 py-2' }, [codeNode, divideBtn]),
        el('td', { class: 'px-2 py-2' }, [refProcCell]),
        el('td', { class: 'px-2 py-2 text-right font-mono text-[12px]', text: `${fmtKg(avail)}` }),
        el('td', { class: 'px-2 py-2' }, [codTIn]),
        el('td', { class: 'px-2 py-2' }, [codMIn]),
        el('td', { class: 'px-2 py-2 text-right' }, [sacosIn]),
        el('td', { class: 'px-2 py-2 text-right' }, [lonasIn]),
        el('td', { class: 'px-2 py-2' }, [empaqueSel]),
        el('td', { class: 'px-2 py-2' }, [colorCell]),
        el('td', { class: 'px-2 py-2' }, [obsIn]),
        el('td', { class: 'px-2 py-2' }, [renderKgCell(lf, avail, { hasPartials: opts.hasPartials })]),
        el('td', { class: 'px-2 py-2 text-center' }, [removeBtn]),
      ]);
      paintRow();
      return tr;
    }

    function makeSplitFields(from) {
      return {
        codigo_trilladora: (from && from.codigo_trilladora) || '',
        codigo_mezcla:     (from && from.codigo_mezcla) || '',
        num_sacos:         (from && from.num_sacos) || '',
        num_lonas:         (from && from.num_lonas) || '',
        empaque_interior:  (from && from.empaque_interior) || '',
        color_cinta:       (from && from.color_cinta) || '',
        observaciones:     (from && from.observaciones) || '',
        kg_dried_to_ship:  '',
      };
    }

    // Fila cabecera de un bache dividido: controles de la división.
    function renderSplitHeaderRow(idx, l, lf, avail) {
      const codeNode = el('span', { class: 'font-mono font-semibold text-navy text-[12px]' }, [
        l.is_blend ? el('span', { class: 'ctrm-pill text-[9px] mr-1', style: 'background:#e8efe3;color:#2e4a2e;', text: 'MZ' }) : null,
        document.createTextNode(l.bache_code || l.blend_code || l.lot_code),
        el('span', { class: 'ctrm-pill text-[9px] ml-1', style: 'background:#f3e8d2;color:#7a5a1e;', text: 'DIVIDIDO' }),
      ]);
      const addBtn = el('button', {
        type: 'button', class: 'ctrm-btn ctrm-btn-soft ctrm-btn-xs',
        onClick: () => { lf.splits.push(makeSplitFields()); renderTable(); },
      }, ['+ Línea']);
      const undoBtn = el('button', {
        type: 'button', class: 'ctrm-btn ctrm-btn-ghost ctrm-btn-xs',
        title: 'Volver a una sola línea',
        onClick: () => { lf.splits = null; renderTable(); },
      }, ['Deshacer división']);
      const removeBtn = el('button', { type: 'button',
        class: 'text-crit text-[16px] font-bold',
        title: 'Quitar del despacho',
        onClick: () => {
          selectedLots.delete(l.id);
          lotFields.delete(l.id);
          refreshAddLotOptions();
          renderTable();
          recountSummary();
        },
      }, ['×']);
      return el('tr', { class: 'border-b-2 border-sand bg-cream/30' }, [
        el('td', { class: 'px-2 py-2 text-ink-300 text-[11px] font-mono', text: String(idx) }),
        el('td', { class: 'px-2 py-2' }, [codeNode]),
        el('td', { class: 'px-2 py-2' }, [
          el('div', { class: 'text-[11px] text-ink-700' }, [
            el('span', { text: l.reference_name || '—' }),
            el('span', { class: 'ctrm-pill ml-1 text-[9px]', style: 'background:#dde7ee;color:#1a3a5c;', text: l.process_type }),
          ]),
        ]),
        el('td', { class: 'px-2 py-2 text-right font-mono text-[12px]', text: `${fmtKg(avail)}` }),
        el('td', { colspan: '8', class: 'px-2 py-2' }, [
          el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
            addBtn, undoBtn,
            el('span', { class: 'text-[10px] text-ink-500 italic',
              text: 'Cada línea P lleva su kg y empaque. Si la suma es menor al disponible, el resto queda en bodega.' }),
          ]),
        ]),
        el('td', { class: 'px-2 py-2 text-center' }, [removeBtn]),
      ]);
    }

    // Línea P de un bache dividido: campos completos propios.
    function renderSplitRow(l, lf, sf, label) {
      const codTIn = el('input', { type: 'text', class: 'ctrm-input mono text-[11px] w-28',
        placeholder: 'PP-XXXX', value: sf.codigo_trilladora || '' });
      codTIn.addEventListener('input', () => { sf.codigo_trilladora = codTIn.value; });
      const codMIn = el('input', { type: 'text', class: 'ctrm-input mono text-[11px] w-24',
        placeholder: '—', value: sf.codigo_mezcla || '' });
      codMIn.addEventListener('input', () => { sf.codigo_mezcla = codMIn.value; });
      const numIn = (field) => {
        const inp = el('input', {
          type: 'text', inputmode: 'numeric', pattern: '[0-9]*',
          class: 'ctrm-input mono text-[11px] text-right w-14', value: sf[field] || '',
        });
        inp.addEventListener('input', () => {
          const cleaned = (inp.value || '').replace(/[^0-9]/g, '');
          if (cleaned !== inp.value) inp.value = cleaned;
          sf[field] = cleaned === '' ? '' : Number(cleaned);
          recountSummary();
        });
        return inp;
      };
      const empaqueSel = el('select', { class: 'ctrm-input text-[10px] w-24' }, [
        el('option', { value: '', selected: !sf.empaque_interior }, ['Ninguno']),
        el('option', { value: 'grainpro', selected: sf.empaque_interior === 'grainpro' }, ['Grain Pro']),
        el('option', { value: 'bolsa', selected: sf.empaque_interior === 'bolsa' }, ['Bolsa plást.']),
      ]);
      empaqueSel.addEventListener('change', () => { sf.empaque_interior = empaqueSel.value; recountSummary(); });
      const colorIn = el('input', {
        type: 'color', value: sf.color_cinta || '#ffffff',
        class: 'cursor-pointer', style: 'width:26px;height:22px;border:1px solid #d8d8d0;border-radius:4px;padding:0;background:none;',
        title: 'Color de cinta de esta línea',
      });
      const paintRow = () => {
        tr.style.background = sf.color_cinta ? hexToRgba(sf.color_cinta, 0.35) : '';
      };
      colorIn.addEventListener('input', () => { sf.color_cinta = colorIn.value; paintRow(); });
      const colorClear = el('button', {
        type: 'button', class: 'text-ink-300 text-[12px] hover:text-crit',
        style: 'background:none;border:none;padding:0 2px;cursor:pointer;',
        title: 'Quitar color',
        onClick: () => { sf.color_cinta = ''; colorIn.value = '#ffffff'; paintRow(); },
      }, ['×']);
      const obsIn = el('input', { type: 'text', class: 'ctrm-input text-[11px] w-32',
        placeholder: 'Observaciones', maxlength: '200', value: sf.observaciones || '' });
      obsIn.addEventListener('input', () => { sf.observaciones = obsIn.value; });
      const kgIn = el('input', {
        type: 'number', step: '0.01', min: '0.01',
        value: sf.kg_dried_to_ship || '',
        class: 'ctrm-input mono text-right text-[11px] w-20',
        style: 'border-color:#e65100;', placeholder: 'kg',
      });
      kgIn.addEventListener('input', () => { sf.kg_dried_to_ship = kgIn.value; });
      const removeBtn = el('button', { type: 'button', class: 'text-crit text-[14px]',
        title: 'Quitar esta línea',
        onClick: () => {
          if (lf.splits.length <= 1) { lf.splits = null; }
          else lf.splits.splice(lf.splits.indexOf(sf), 1);
          renderTable();
        },
      }, ['×']);
      const tr = el('tr', { class: 'border-b border-sand bg-white' }, [
        el('td', { class: 'px-2 py-1.5' }, []),
        el('td', { class: 'px-2 py-1.5 pl-6 font-mono font-semibold text-navy text-[11px]',
          text: `↳ ${label}` }),
        el('td', { class: 'px-2 py-1.5' }, []),
        el('td', { class: 'px-2 py-1.5' }, []),
        el('td', { class: 'px-2 py-1.5' }, [codTIn]),
        el('td', { class: 'px-2 py-1.5' }, [codMIn]),
        el('td', { class: 'px-2 py-1.5 text-right' }, [numIn('num_sacos')]),
        el('td', { class: 'px-2 py-1.5 text-right' }, [numIn('num_lonas')]),
        el('td', { class: 'px-2 py-1.5' }, [empaqueSel]),
        el('td', { class: 'px-2 py-1.5' }, [el('div', { class: 'flex items-center gap-0.5' }, [colorIn, colorClear])]),
        el('td', { class: 'px-2 py-1.5' }, [obsIn]),
        el('td', { class: 'px-2 py-1.5 text-right' }, [kgIn]),
        el('td', { class: 'px-2 py-1.5 text-center' }, [removeBtn]),
      ]);
      paintRow();
      return tr;
    }

    function renderLotHeaderRow(idx, l, lf, eligPartialsList) {
      const codeNode = el('span', { class: 'font-mono font-semibold text-navy text-[12px]' }, [
        l.is_blend ? el('span', { class: 'ctrm-pill text-[9px] mr-1', style: 'background:#e8efe3;color:#2e4a2e;', text: 'MZ' }) : null,
        document.createTextNode(l.bache_code || l.blend_code || l.lot_code),
      ]);
      const refProcCell = el('div', {}, [
        el('div', { class: 'text-[11px] text-ink-700' }, [
          el('span', { text: l.reference_name || '—' }),
          el('span', { class: 'ctrm-pill ml-1 text-[9px]', style: 'background:#dde7ee;color:#1a3a5c;', text: l.process_type }),
        ]),
        el('label', { class: 'inline-flex items-center gap-1 cursor-pointer mt-1 text-[10px] text-ink-500' }, [
          el('input', { type: 'checkbox', class: 'h-3 w-3 accent-navy',
            onChange: () => { lf.partials_merged = true; autoSelectPartials(l.id); renderTable(); },
          }),
          el('span', {}, [`Parciales separados (${eligPartialsList.length}) ↓`]),
        ]),
      ]);
      const totalKg = eligPartialsList.reduce((s, p) => s + Number(p.kg_dried || 0), 0);
      const removeBtn = el('button', { type: 'button',
        class: 'text-crit text-[16px] font-bold',
        onClick: () => {
          selectedLots.delete(l.id);
          deselectAllPartials(l.id);
          lotFields.delete(l.id);
          refreshAddLotOptions();
          renderTable();
          recountSummary();
        },
      }, ['×']);
      return el('tr', { class: 'border-b-2 border-sand bg-cream/30' }, [
        el('td', { class: 'px-2 py-2 text-ink-300 text-[11px] font-mono', text: String(idx) }),
        el('td', { class: 'px-2 py-2' }, [codeNode]),
        el('td', { class: 'px-2 py-2' }, [refProcCell]),
        el('td', { class: 'px-2 py-2 text-right font-mono text-[12px]', text: `${fmtKg(totalKg)}` }),
        el('td', { colspan: '8', class: 'px-2 py-2 text-[10px] text-ink-500 italic',
          text: 'Códigos y sacos por parcial ↓ (empaque/color/observaciones se toman del bache)' }),
        el('td', { class: 'px-2 py-2 text-center' }, [removeBtn]),
      ]);
    }

    function renderPartialSubRow(p, pf, kg) {
      const codTIn = el('input', { type: 'text', class: 'ctrm-input mono text-[11px] w-28', value: pf.codigo_trilladora || '' });
      codTIn.addEventListener('input', () => { pf.codigo_trilladora = codTIn.value; });
      const codMIn = el('input', { type: 'text', class: 'ctrm-input mono text-[11px] w-24', value: pf.codigo_mezcla || '' });
      codMIn.addEventListener('input', () => { pf.codigo_mezcla = codMIn.value; });
      const sIn = el('input', {
        type: 'text', inputmode: 'numeric', pattern: '[0-9]*',
        class: 'ctrm-input mono text-[11px] text-right w-16', value: pf.num_sacos || '',
      });
      sIn.addEventListener('input', () => {
        const cleaned = (sIn.value || '').replace(/[^0-9]/g, '');
        if (cleaned !== sIn.value) sIn.value = cleaned;
        pf.num_sacos = cleaned === '' ? '' : Number(cleaned);
      });
      const removeBtn = el('button', { type: 'button', class: 'text-crit text-[14px]',
        title: 'Quitar parcial',
        onClick: () => { partialIds.delete(p.id); renderTable(); recountSummary(); },
      }, ['×']);
      return el('tr', { class: 'border-b border-sand bg-white' }, [
        el('td', { class: 'px-2 py-1.5' }, []),
        el('td', { class: 'px-2 py-1.5 pl-6 text-[11px] text-ink-500 font-mono',
          text: `↳ P${p.parcial_letter || ''}` }),
        el('td', { class: 'px-2 py-1.5' }, []),
        el('td', { class: 'px-2 py-1.5 text-right font-mono text-[11px]', text: `${fmtKg(kg)}` }),
        el('td', { class: 'px-2 py-1.5' }, [codTIn]),
        el('td', { class: 'px-2 py-1.5' }, [codMIn]),
        el('td', { class: 'px-2 py-1.5 text-right' }, [sIn]),
        el('td', { colspan: '4', class: 'px-2 py-1.5 text-[10px] text-ink-300 italic', text: 'hereda del bache' }),
        el('td', { class: 'px-2 py-1.5 text-right font-mono text-[11px] text-ok font-bold', text: `${fmtKg(kg)}` }),
        el('td', { class: 'px-2 py-1.5 text-center' }, [removeBtn]),
      ]);
    }

    function renderTable() {
      clear(tableEl);
      if (selectedLots.size === 0) {
        tableEl.append(el('div', { class: 'text-center text-[12px] text-ink-300 py-6 px-3',
          text: 'No hay baches seleccionados. Agrega uno desde el selector arriba.' }));
        return;
      }
      let idx = 1;
      let totalDried = 0;
      let totalSacos = 0;
      let totalLonas = 0;
      let totalGP = 0;
      let totalBolsas = 0;
      const addEmpaque = (lf) => {
        const bultos = Number(lf.num_sacos || 0) + Number(lf.num_lonas || 0);
        if (lf.empaque_interior === 'grainpro') totalGP += bultos;
        else if (lf.empaque_interior === 'bolsa') totalBolsas += bultos;
      };
      const tbody = el('tbody', {});
      for (const lotId of [...selectedLots]) {
        const l = readyLotsById.get(lotId);
        if (!l) continue;
        const partials = l.partials || [];
        const lf = getLotFields(lotId);
        if (partials.length === 0) {
          const avail = Number(l.kg_dried_available != null ? l.kg_dried_available : (l.kg_dried_output || 0));
          if (lf.splits) {
            // Bache dividido: fila cabecera + una línea P por división.
            const priorMax = maxSplitP(l);
            tbody.append(renderSplitHeaderRow(idx++, l, lf, avail));
            lf.splits.forEach((sf, i) => {
              totalDried += Number(sf.kg_dried_to_ship || 0);
              totalSacos += Number(sf.num_sacos || 0);
              totalLonas += Number(sf.num_lonas || 0);
              addEmpaque(sf);
              tbody.append(renderSplitRow(l, lf, sf, `P${priorMax + i + 1}`));
            });
          } else {
            const kgToShip = lf.kg_mode === 'parcial' && lf.kg_dried_to_ship !== ''
              ? Number(lf.kg_dried_to_ship)
              : (lf.kg_mode === 'todo' && lf.kg_real !== '' ? Number(lf.kg_real) : avail);
            totalDried += kgToShip;
            totalSacos += Number(lf.num_sacos || 0);
            totalLonas += Number(lf.num_lonas || 0);
            addEmpaque(lf);
            tbody.append(renderLotRow(idx++, l, lf, avail));
          }
        } else {
          const elig = eligPartials(l);
          if (lf.partials_merged !== false) {
            const avail = elig.reduce((s, p) => s + Number(p.kg_dried || 0), 0);
            const kgToShip = lf.kg_mode === 'parcial' && lf.kg_dried_to_ship !== ''
              ? Number(lf.kg_dried_to_ship) : avail;
            totalDried += kgToShip;
            totalSacos += Number(lf.num_sacos || 0);
            totalLonas += Number(lf.num_lonas || 0);
            addEmpaque(lf);
            tbody.append(renderLotRow(idx++, l, lf, avail, { hasPartials: true, partialsCount: elig.length }));
          } else {
            const selectedPartials = elig.filter((p) => partialIds.has(p.id));
            tbody.append(renderLotHeaderRow(idx++, l, lf, selectedPartials));
            for (const p of selectedPartials) {
              const pf = getPartialFields(p.id);
              const kg = Number(p.kg_dried || 0);
              totalDried += kg;
              totalSacos += Number(pf.num_sacos || 0);
              tbody.append(renderPartialSubRow(p, pf, kg));
            }
          }
        }
      }
      const table = el('table', { class: 'w-full text-[12px]' }, [
        el('thead', {}, [el('tr', { class: 'bg-navy text-yellow' }, [
          el('th', { class: 'px-2 py-2 text-left uppercase tracking-eyebrow text-[9px]' }, ['#']),
          el('th', { class: 'px-2 py-2 text-left uppercase tracking-eyebrow text-[9px]' }, ['Bache']),
          el('th', { class: 'px-2 py-2 text-left uppercase tracking-eyebrow text-[9px]' }, ['Ref / Proceso']),
          el('th', { class: 'px-2 py-2 text-right uppercase tracking-eyebrow text-[9px]' }, ['kg seco disp.']),
          el('th', { class: 'px-2 py-2 text-left uppercase tracking-eyebrow text-[9px]' }, ['Cód. Trilladora']),
          el('th', { class: 'px-2 py-2 text-left uppercase tracking-eyebrow text-[9px]' }, ['Cód. Mezcla']),
          el('th', { class: 'px-2 py-2 text-right uppercase tracking-eyebrow text-[9px]' }, ['Sacos']),
          el('th', { class: 'px-2 py-2 text-right uppercase tracking-eyebrow text-[9px]' }, ['Lonas']),
          el('th', { class: 'px-2 py-2 text-left uppercase tracking-eyebrow text-[9px]' }, ['Empaque']),
          el('th', { class: 'px-2 py-2 text-left uppercase tracking-eyebrow text-[9px]' }, ['Color']),
          el('th', { class: 'px-2 py-2 text-left uppercase tracking-eyebrow text-[9px]' }, ['Observaciones']),
          el('th', { class: 'px-2 py-2 text-right uppercase tracking-eyebrow text-[9px]' }, ['kg seco a desp.']),
          el('th', { class: 'px-2 py-2 text-center uppercase tracking-eyebrow text-[9px]' }, ['']),
        ])]),
        tbody,
        el('tfoot', {}, [el('tr', { class: 'bg-cream border-t-2 border-navy' }, [
          el('td', { colspan: '3', class: 'px-2 py-2 text-right font-display font-bold text-navy text-[11px] uppercase tracking-eyebrow',
            text: `Total · ${selectedLots.size} bache(s)` }),
          el('td', { class: 'px-2 py-2 text-right font-mono font-bold text-navy', text: '' }),
          el('td', { colspan: '2' }, []),
          el('td', { class: 'px-2 py-2 text-right font-mono font-bold text-navy', text: String(totalSacos) }),
          el('td', { class: 'px-2 py-2 text-right font-mono font-bold text-navy', text: String(totalLonas) }),
          el('td', { colspan: '3', class: 'px-2 py-2 text-[10px] font-mono font-semibold text-ink-700',
            text: `GP: ${totalGP} · Bolsa: ${totalBolsas}` }),
          el('td', { class: 'px-2 py-2 text-right font-mono font-bold text-navy', text: `${fmtKg(totalDried)}` }),
          el('td', {}, []),
        ])]),
      ]);
      tableEl.append(table);
    }
    renderTable();
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
      // Picker para agregar
      el('div', { class: 'flex items-center gap-2' }, [
        el('label', { class: 'ctrm-label whitespace-nowrap', text: 'Baches a despachar' }),
        addLotSelect,
      ]),
      // Tabla
      tableEl,
      counter,
      el('div', { class: 'flex flex-wrap justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        (() => {
          const draftBtn = el('button', {
            class: 'ctrm-btn ctrm-btn-soft', type: 'button',
            title: 'Guarda un borrador de preparación para bodega. Aparta el inventario pero no despacha ni completa pedidos.',
          }, ['📋 Guardar borrador']);
          const submitBtn = el('button', {
            class: 'ctrm-btn ctrm-btn-primary', type: 'button',
          }, ['Generar despacho']);

          // Validación de divisiones común a ambos modos.
          function validateSplits() {
            for (const lid of selectedLots) {
              const l = readyLotsById.get(lid);
              const lf = lotFields.get(lid);
              if (!l || !lf || !lf.splits) continue;
              const code = l.bache_code || l.blend_code || l.lot_code;
              const kgs = lf.splits.map((sf) => Number(sf.kg_dried_to_ship || 0));
              if (kgs.some((k) => !(k > 0))) {
                toast(`División de ${code}: cada línea necesita kg > 0`, 'warning'); return false;
              }
              const avail = Number(l.kg_dried_available != null ? l.kg_dried_available : (l.kg_dried_output || 0));
              const sum = kgs.reduce((a, b) => a + b, 0);
              if (sum > avail + 0.01) {
                toast(`División de ${code}: la suma (${fmtKg(sum)} kg) supera los ${fmtKg(avail)} kg disponibles`, 'warning'); return false;
              }
            }
            return true;
          }
          function basePayload(items) {
            return {
              shipment_code: codeInput.value.trim() || undefined,
              shipment_date: dateInput.value,
              notes: notesInput.value || undefined,
              destino_kind: destinoSelect.value || undefined,
              destino_other: destinoSelect.value === 'Otro' ? destinoOtherInput.value.trim() : undefined,
              driver_cedula: driverCedula.value.trim() || undefined,
              driver_placas: driverPlacas.value.trim() || undefined,
              driver_name:   driverName.value.trim()   || undefined,
              items,
            };
          }

          // mode: 'confirm' (despacho real) | 'draft' (borrador)
          async function submit(mode) {
            const btn = mode === 'draft' ? draftBtn : submitBtn;
            const label = mode === 'draft' ? '📋 Guardar borrador' : 'Generar despacho';
            if (btn.disabled) return;
            if (!validateSplits()) return;
            const items = buildItems(readyLots, selectedLots, partialIds, lotFields, partialFields);
            if (items.length === 0) { toast('Selecciona al menos un bache', 'warning'); return; }
            // El destino "Otro" sin especificar solo bloquea el despacho
            // definitivo; un borrador puede ir sin destino aún.
            if (mode === 'confirm' && destinoSelect.value === 'Otro' && !destinoOtherInput.value.trim()) {
              toast('Especifica el destino "Otro"', 'warning'); return;
            }
            if (mode === 'confirm') {
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
            }
            btn.disabled = true;
            btn.textContent = mode === 'draft' ? 'Guardando…' : 'Generando…';
            try {
              const payload = { ...basePayload(items), draft: mode === 'draft' };
              let r;
              try {
                r = await api.shipmentsCreate(payload);
              } catch (e) {
                if (e && e.code === 'PESO_REAL_CONFIRM_REQUIRED') {
                  const okReal = await confirmModal(
                    `${e.message}\n\nSi el peso de báscula es correcto, el bache cierra con esa diferencia registrada como merma/ganancia de humedad.`,
                    { title: 'Peso báscula difiere del registrado' },
                  );
                  if (!okReal) { btn.disabled = false; btn.textContent = label; return; }
                  r = await api.shipmentsCreate({ ...payload, override_peso_real: true });
                } else { throw e; }
              }
              if (mode === 'draft') {
                toast(`Borrador ${r.shipment.shipment_code} guardado · inventario apartado`, 'success', 4500);
              } else {
                const compl = (r.completions || []).length;
                toast(`Despacho ${r.shipment.shipment_code} creado${compl ? ` · ${compl} pedido(s) completado(s)` : ''}`, 'success', 4500);
              }
              close({ ok: true });
              await reload();
            } catch (e) {
              toast(e.message, 'error');
              btn.disabled = false;
              btn.textContent = label;
            }
          }
          draftBtn.addEventListener('click', () => submit('draft'));
          submitBtn.addEventListener('click', () => submit('confirm'));
          return el('div', { class: 'flex gap-2' }, [draftBtn, submitBtn]);
        })(),
      ]),
    ]);
  }
}

// Inputs por bache (código trilladora / código mezcla / # sacos) que
// aparecen cuando el bache está seleccionado en el despacho.
function perLotInputs(lot, fields, opts = {}) {
  const t = el('input', { type: 'text', class: 'ctrm-input mono text-[11px]',
    placeholder: 'PP-XXXX', value: fields.codigo_trilladora || '' });
  const m = el('input', { type: 'text', class: 'ctrm-input mono text-[11px]',
    placeholder: 'Código mezcla', value: fields.codigo_mezcla || '' });
  const s = el('input', { type: 'number', min: '0', step: '1', class: 'ctrm-input mono text-[11px] text-right',
    placeholder: '0', value: fields.num_sacos || '' });
  t.addEventListener('input', () => { fields.codigo_trilladora = t.value; });
  m.addEventListener('input', () => { fields.codigo_mezcla    = m.value; });
  s.addEventListener('input', () => { fields.num_sacos        = s.value === '' ? '' : Math.max(0, Math.floor(Number(s.value) || 0)); });

  // Campo de kg seco a despachar (solo para whole-lot sin partials).
  const kgAvail = Number(lot.kg_dried_available != null ? lot.kg_dried_available : (lot.kg_dried_output || 0));
  const showKgField = !opts.partialsContext && (lot.partials || []).length === 0;
  let kgField = null;
  if (showKgField) {
    kgField = el('input', { type: 'number', min: '0.01', step: '0.01',
      max: String(kgAvail),
      class: 'ctrm-input mono text-[11px] text-right',
      placeholder: `Todo: ${fmtKg(kgAvail)}`,
      value: fields.kg_dried_to_ship || '' });
    kgField.addEventListener('input', () => { fields.kg_dried_to_ship = kgField.value; });
  }

  const cols = showKgField ? 'grid-cols-4' : 'grid-cols-3';
  return el('div', { class: `grid ${cols} gap-2 mt-2 p-2 rounded-md bg-cream` }, [
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
    showKgField ? el('label', { class: 'block' }, [
      el('span', { class: 'text-[10px] text-ink-500 uppercase tracking-eyebrow', text: 'kg seco a despachar' }),
      kgField,
    ]) : null,
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
  const norm = (f) => {
    const base = {
      codigo_trilladora: (f.codigo_trilladora || '').trim() || null,
      codigo_mezcla:     (f.codigo_mezcla || '').trim() || null,
      num_sacos:         f.num_sacos === '' || f.num_sacos == null ? null : Number(f.num_sacos),
      num_lonas:         f.num_lonas === '' || f.num_lonas == null ? null : Number(f.num_lonas),
      empaque_interior:  f.empaque_interior || null,
      color_cinta:       f.color_cinta || null,
      observaciones:     (f.observaciones || '').trim() || null,
    };
    // kg parcial a despachar (si se indica, despacho parcial)
    if (f.kg_dried_to_ship != null && f.kg_dried_to_ship !== '') {
      base.kg_dried_to_ship = Number(f.kg_dried_to_ship);
    }
    return base;
  };
  for (const l of readyLots) {
    const partials = l.partials || [];
    const lf = lotFields.get(l.id) || { codigo_trilladora: '', codigo_mezcla: '', num_sacos: '', partials_merged: true };
    if (partials.length === 0) {
      if (wholeLots.has(l.id)) {
        if (lf.splits && lf.splits.length > 0) {
          // División P1/P2: una línea por división, cada una con su
          // kg y empaque. El servidor asigna los split_label.
          for (const sf of lf.splits) {
            items.push({
              production_lot_id: l.id, partial_ids: null,
              ...norm(sf),
              split: true,
              partials_merged: true,
            });
          }
        } else if (lf.kg_mode === 'todo' || lf.kg_mode == null) {
          // Despacho total: cierra el bache. Si el peso de báscula
          // difiere del registrado, va como kg real (merma/ganancia).
          const avail = Number(l.kg_dried_available != null ? l.kg_dried_available : (l.kg_dried_output || 0));
          const item = {
            production_lot_id: l.id, partial_ids: null,
            ...norm({ ...lf, kg_dried_to_ship: '' }),
            close_lot: true,
            partials_merged: true,
          };
          const real = lf.kg_real === '' || lf.kg_real == null ? null : Number(lf.kg_real);
          if (real != null && Math.abs(real - avail) >= 0.01) item.kg_dried_to_ship = real;
          items.push(item);
        } else {
          items.push({
            production_lot_id: l.id, partial_ids: null,
            ...norm(lf),
            partials_merged: true,
          });
        }
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
        // Empaque, color y observaciones se heredan del bache (lf).
        for (const pid of selected) {
          const pf = partialFields.get(pid) || { codigo_trilladora: '', codigo_mezcla: '', num_sacos: '' };
          items.push({
            production_lot_id: l.id, partial_ids: [pid],
            ...norm({
              ...pf,
              empaque_interior: lf.empaque_interior,
              color_cinta: lf.color_cinta,
              observaciones: lf.observaciones,
            }),
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

// #rrggbb → rgba() con alpha, para pintar la fila del modal con el
// color de cinta sin tapar los inputs.
// Mayor número P de las divisiones ya despachadas de un bache (viene
// en lot.shipments[].split_label desde production-lots-list). La
// numeración de nuevas divisiones continúa desde ahí.
function maxSplitP(lot) {
  let max = 0;
  for (const s of lot.shipments || []) {
    const m = /^P(\d+)$/.exec(s.split_label || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function hexToRgba(hex, alpha) {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex || '');
  if (!m) return '';
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
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
