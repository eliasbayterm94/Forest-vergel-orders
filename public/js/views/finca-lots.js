// Finca production module — CTRM-styled.
import { el, clear } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { openModal, confirmModal } from '../ui/modal.js';
import { createCombobox, createMultiCombobox } from '../ui/combobox.js';
import { listView } from '../ui/list.js';
import { fmtKg, fmtDate, statusLabel, statusPillKind } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { emptyStateCard } from '../ui/empty.js';
import { navigate } from '../router.js';

const LOT_STATUSES = ['InFermentation', 'Drying', 'Resting', 'Ready'];
const LOT_STATUS_LABELS = {
  InFermentation: 'En fermentación',
  Drying: 'Secado',
  Resting: 'Reposo',
  Ready: 'Listo',
};

const PROCESS_TYPES = ['Natural', 'Honey', 'Lavado'];

// Input-stage divisors. Mirror processYields.js on the server.
const INPUT_STAGE_DIVISORS = { cereza: 7.65, despulpado: 4.20, seco: 1.34 };
const STAGE_OPTIONS = [
  { value: 'cereza',     label: 'Cereza fresca',  inputLabel: 'kg de cereza fresca' },
  { value: 'despulpado', label: 'Despulpado',     inputLabel: 'kg de café despulpado' },
  { value: 'seco',       label: 'Seco',           inputLabel: 'kg de café seco' },
];

// Per-lot yield formula at the Ready transition:
//   kg_green = (kg_seco / factor_rendimiento) * KG_PER_SACO
// (Mirrors processYields.js — server is the source of truth.)
const KG_PER_SACO = 70;

// Generic dried label (factor is per-lot, not per-process anymore).
const DRIED_LABEL_GENERIC = 'Peso seco';
const DRIED_LABELS_LEGACY = {
  Natural: 'Cereza seca',
  Honey:   'Pergamino seco (honey)',
  Lavado:  'Pergamino seco (lavado)',
};

// New flow skips Resting (Drying → Ready) and ends at Ready —
// the Ready → Delivered transition now happens via Despachos
// (see finca-despachos.js / shipments-create handler).
const NEXT_STATUS = {
  InFermentation: 'Drying',
  Drying:         'Ready',
  Resting:        'Ready',  // legacy
  // Ready: no direct next — use Despachos.
};

export async function fincaLotsView() {
  const refsResP = api.references();
  const varsResP = api.varieties();
  const lotsResP = api.lotsList({ active_only: 'true' });
  const infResP  = api.infusions().catch(() => ({ infusions: [] }));

  const [refsRes, varsRes, lotsRes, infRes] = await Promise.all([refsResP, varsResP, lotsResP, infResP]);
  let lots = lotsRes.lots;
  const refs = refsRes.references;
  const allVarieties = varsRes.varieties;
  let allInfusions = (infRes && infRes.infusions) || [];

  // Estado expand/collapse por lote. Por default colapsado en mobile,
  // expandido en desktop. El usuario puede alternar. matchMedia puede
  // no existir (jsdom en tests), default a desktop en ese caso.
  const mq = (typeof window !== 'undefined' && window.matchMedia)
    ? window.matchMedia('(max-width: 640px)') : { matches: false };
  const isMobile = mq.matches;
  const expanded = new Set();   // lot_id que estan expandidos
  if (!isMobile) {
    for (const l of lots) expanded.add(l.id);
  }

  const list = el('div', { class: 'space-y-3' });

  function render() {
    clear(list);
    list.append(listView({
      items: lots,
      renderItem: lotCard,
      viewModeKey: 'finca-lots',
      tableHeaders: [
        { label: 'Bache' }, { label: 'Referencia' }, { label: 'Status' }, { label: 'Proceso' },
        { label: 'Infusión' },
        { label: 'Cereza',     cls: 'text-right' },
        { label: 'Verde esp.', cls: 'text-right' },
        { label: 'Verde real', cls: 'text-right' },
        { label: 'Asignado',   cls: 'text-right' },
        { label: 'Parciales',  cls: 'text-right' },
        { label: 'Acciones',   cls: 'text-right' },
      ],
      tableRow: lotTableRow,
      pageSize: 20,
      emptyText: () => emptyStateCard({
        title: 'Sin lotes activos',
        description: 'Crea el primer lote cuando llegue cereza al beneficio.',
        action: { label: '+ Nuevo lote', onClick: () => createLot() },
      }),
      searchPlaceholder: 'Buscar código de lote, referencia...',
      searchMatch: (l, q) => {
        const lo = q.toLowerCase();
        return [l.bache_code, l.lot_code, l.reference_name].some((s) => (s || '').toLowerCase().includes(lo));
      },
      filters: [
        { key: 'status',          label: 'Estado',  options: LOT_STATUSES, optionLabels: LOT_STATUS_LABELS, getter: (l) => l.status },
        { key: 'process_type',    label: 'Proceso', options: ['Natural', 'Honey', 'Lavado'], getter: (l) => l.process_type },
        { key: 'processing_stage',label: 'Etapa',   options: ['cereza', 'despulpado', 'seco'], getter: (l) => l.processing_stage || '' },
        { key: 'infusion_name',   label: 'Infusión', multi: true,
          options: [...new Set(lots.map((l) => l.infusion_name).filter(Boolean))].sort(),
          getter: (l) => l.infusion_name || '' },
      ],
      sorts: [
        { key: 'start_desc', label: 'Inicio: más reciente', getter: (l) => l.start_date,        dir: 'desc' },
        { key: 'start_asc',  label: 'Inicio: más antiguo',  getter: (l) => l.start_date,        dir: 'asc' },
        { key: 'kg_desc',    label: 'Mayor verde esperado', getter: (l) => Number(l.kg_green_expected || 0), dir: 'desc' },
      ],
      defaultSort: 'start_desc',
      totals: [
        { label: 'Lotes',              value: (arr) => String(arr.length) },
        { label: 'Cereza fresca',      value: (arr) => fmtKg(arr.reduce((s, l) => s + Number(l.kg_cherry_input || 0), 0)) },
        { label: 'Verde esperado',     value: (arr) => fmtKg(arr.reduce((s, l) => s + Number(l.kg_green_expected || 0), 0)) },
        { label: 'Verde real',         value: (arr) => fmtKg(arr.reduce((s, l) => s + Number(l.kg_green_actual || 0), 0)) },
      ],
    }));
  }
  render();

  return chrome(el('div', {}, [
    pageTitle('Producción', 'Lotes activos en El Vergel'),
    el('div', { class: 'mb-4 flex justify-end gap-2' }, [
      el('button', {
        class: 'ctrm-btn ctrm-btn-soft uppercase tracking-eyebrow text-[11px] py-2.5 px-5',
        title: 'Crea varios baches a la vez en una tabla',
        onClick: () => navigate('/finca/lots-bulk'),
      }, ['+ Crear varios']),
      el('button', {
        class: 'ctrm-btn ctrm-btn-yellow uppercase tracking-eyebrow text-[11px] py-2.5 px-5',
        onClick: () => createLot(),
      }, ['+ Crear lote']),
    ]),
    list,
  ]));

  // ---------- Lot table row (table-mode renderer) ----------
  function lotTableRow(l) {
    const totalAllocated = (l.assignments || []).reduce((s, a) => s + Number(a.kg_green_allocated || 0), 0);
    const cap = Number(l.kg_green_actual ?? l.kg_green_expected ?? 0);
    const overflow = totalAllocated - cap;
    const partials = l.partials || [];
    const code = l.bache_code || l.lot_code;
    const next = NEXT_STATUS[l.status];
    const closeBacheLabel = (next === 'Ready' && partials.length > 0) ? 'Cerrar' : (next ? `→ ${statusLabel(next)}` : null);

    const tcell = (label, classes, content) => {
      const td = el('td', { class: classes });
      td.setAttribute('data-label', label);
      if (content instanceof Node) td.append(content);
      else td.append(document.createTextNode(String(content == null ? '—' : content)));
      return td;
    };

    const actionBtn = (label, variant, onClick) =>
      el('button', {
        type: 'button',
        class: `ctrm-btn ctrm-btn-${variant} ctrm-btn-xs`,
        onClick: (e) => { e.stopPropagation(); onClick(); },
      }, [label]);

    const actionsCell = el('div', { class: 'inline-flex gap-1 flex-wrap justify-end' }, [
      next ? actionBtn(closeBacheLabel, 'primary', () => advanceStatus(l, next)) : null,
      l.status === 'Ready' ? actionBtn('Despachar', 'yellow', () => { location.hash = '/finca/despachos'; }) : null,
      actionBtn('Asignar', 'soft', () => assignLot(l)),
    ]);

    return el('tr', {
      class: 'hover:bg-cream',
    }, [
      tcell('Bache', 'font-mono text-navy font-semibold cursor-pointer', el('span', {
        onClick: () => assignLot(l),
      }, [code])),
      tcell('Referencia', '', l.reference_name || '—'),
      tcell('Status', '', el('span', { class: `ctrm-pill ${statusPillKind(l.status)}`, text: statusLabel(l.status) })),
      tcell('Proceso', 'text-[11px]', l.process_type),
      tcell('Infusión', 'text-[11px]', l.infusion_name
        ? `${l.infusion_name} ${l.infusion_pct}%`
        : '—'),
      tcell('Cereza', 'text-right font-mono', fmtKg(l.kg_cherry_input)),
      tcell('Verde esp.', 'text-right font-mono', fmtKg(l.kg_green_expected)),
      tcell('Verde real', 'text-right font-mono', l.kg_green_actual != null ? fmtKg(l.kg_green_actual) : '—'),
      tcell('Asignado',
        `text-right font-mono ${overflow > 0.01 ? 'text-crit font-bold' : ''}`,
        fmtKg(totalAllocated)),
      tcell('Parciales', 'text-right font-mono',
        partials.length > 0 ? `${partials.length}/6` : '—'),
      tcell('Acciones', 'text-right', actionsCell),
    ]);
  }

  // ---------- Lot card ----------
  function lotCard(l) {
    const next = NEXT_STATUS[l.status];
    const totalAllocated = (l.assignments || []).reduce((s, a) => s + Number(a.kg_green_allocated || 0), 0);
    const capacity  = Number(l.kg_green_actual ?? l.kg_green_expected ?? 0);
    const remaining = capacity - totalAllocated;
    const overflow  = totalAllocated - capacity;       // positive when over-allocated
    const isOverAllocated = overflow > 0.01;
    const stageLabel = stageLabelOf(l);
    const partials = l.partials || [];
    const isDrying = l.status === 'Drying';
    const closeBacheLabel = (next === 'Ready' && partials.length > 0)
      ? 'Cerrar bache' : (next ? `→ ${statusLabel(next)}` : null);

    // Lotes con problemas (over-allocated) siempre se expanden para que
    // el banner sea visible.
    const isExp = isOverAllocated || expanded.has(l.id);
    const toggleExpand = () => {
      if (isExp && !isOverAllocated) expanded.delete(l.id);
      else expanded.add(l.id);
      render();
    };

    return el('div', { class: 'ctrm-card ctrm-card-pad' }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-2' }, [
        el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
          el('span', { class: 'ctrm-code', text: l.bache_code || l.lot_code }),
          (l.bache_code && l.bache_code !== l.lot_code)
            ? el('span', { class: 'text-[10px] text-ink-300 font-mono', text: l.lot_code })
            : null,
          el('span', { class: 'font-display font-semibold text-navy text-[13px]', text: l.reference_name || '—' }),
          el('span', { class: `ctrm-pill ${statusPillKind(l.status)}`, text: statusLabel(l.status) }),
          stageLabel ? el('span', { class: 'ctrm-pill muted', text: stageLabel }) : null,
          infusionPill(l),
        ]),
        el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
          next ? el('button', {
            class: 'ctrm-btn ctrm-btn-primary ctrm-btn-sm',
            onClick: () => advanceStatus(l, next),
          }, [closeBacheLabel]) : null,
          // Ready lots get a "Despachar" shortcut that jumps to the Despachos view.
          (l.status === 'Ready') ? el('button', {
            class: 'ctrm-btn ctrm-btn-yellow ctrm-btn-sm',
            onClick: () => { location.hash = '/finca/despachos'; },
          }, ['Despachar']) : null,
          el('button', {
            class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
            onClick: () => assignLot(l),
          }, ['Asignar pedidos']),
          el('button', {
            class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
            title: 'Editar código de bache',
            onClick: () => editBacheCode(l),
          }, ['Editar bache']),
        ]),
      ]),
      el('div', { class: 'flex flex-wrap text-[12px] text-ink-500 gap-x-4 gap-y-1 font-mono' }, [
        l.kg_cherry_input     != null ? meta('Cereza fresca', fmtKg(l.kg_cherry_input)) : null,
        l.kg_despulpado_input != null ? meta('Despulpado',    fmtKg(l.kg_despulpado_input)) : null,
        meta('Verde esperado', fmtKg(l.kg_green_expected)),
        l.kg_dried_output != null ? meta(DRIED_LABEL_GENERIC, fmtKg(l.kg_dried_output)) : null,
        l.factor_rendimiento != null ? meta('Factor', String(l.factor_rendimiento)) : null,
        l.kg_green_actual != null ? meta('Verde real', fmtKg(l.kg_green_actual)) : null,
        meta('Inicio', fmtDate(l.start_date)),
        l.drying_start_date ? meta('Drying', fmtDate(l.drying_start_date)) : null,
        meta('Asignado', fmtKg(totalAllocated)),
        metaColor('Disponible', fmtKg(remaining), remaining < -0.001 ? 'crit' : null),
        meta('Proceso', l.process_type),
      ]),
      // ── Detalle expandible ───────────────────────────────────────
      isExp ? el('div', {}, [
        (l.varieties || []).length > 0
          ? el('div', { class: 'flex flex-wrap gap-1 mt-2' }, (l.varieties || []).map((v) =>
              el('span', { class: 'ctrm-pill dark', text: v.name }),
            ))
          : null,

        // Discrepancy banner — appears only when assignments exceed capacity
        isOverAllocated
          ? el('div', {
              class: 'mt-3 rounded-lg bg-crit-bg border-l-4 border-crit p-3 flex flex-wrap items-center justify-between gap-2',
            }, [
              el('div', { class: 'text-[12px] text-crit flex items-center gap-2 min-w-0' }, [
                el('span', { text: '⚠' }),
                el('div', {}, [
                  el('strong', {}, [`Asignaciones (${fmtKg(totalAllocated)}) exceden capacidad (${fmtKg(capacity)})`]),
                  el('div', { class: 'text-[11px] mt-0.5' }, [`Sobra: ${fmtKg(overflow)} verde. Ajusta antes de despachar.`]),
                ]),
              ]),
              el('button', {
                class: 'ctrm-btn ctrm-btn-danger ctrm-btn-sm shrink-0',
                onClick: () => rescaleAssignments(l, capacity, totalAllocated),
              }, ['Ajustar proporcionalmente']),
            ])
          : null,

        // Parciales (visibles cuando esta en Drying, Ready o cuando ya hay alguno)
        (isDrying || partials.length > 0) ? partialsSection(l, partials) : null,

        (l.assignments || []).length > 0
          ? el('div', { class: 'mt-3 border-t border-sand pt-2' }, [
              el('p', { class: 'eyebrow mb-1.5', text: 'Asignaciones' }),
              el('div', { class: 'space-y-1' }, l.assignments.map((a) => assignmentRow(a, l, capacity))),
            ])
          : null,
      ]) : null,

      // ── Toggle compact/expand. Si el lote esta over-allocated forzamos
      //    expand y ocultamos el toggle (no se puede colapsar mientras
      //    hay un problema).                                        */
      isOverAllocated ? null : el('div', {
        class: 'mt-2 pt-2 border-t border-sand flex items-center justify-between gap-2',
      }, [
        el('span', { class: 'text-[11px] text-ink-300 font-mono' }, [
          isExp ? 'Detalle visible' : compactSummary(l, partials, totalAllocated, capacity),
        ]),
        el('button', {
          class: 'ctrm-btn ctrm-btn-ghost ctrm-btn-xs',
          type: 'button',
          onClick: toggleExpand,
        }, [isExp ? 'Ver menos' : 'Ver más']),
      ]),
    ]);
  }

  function compactSummary(l, partials, totalAllocated, capacity) {
    const parts = [];
    if (partials.length > 0) {
      const rejected = partials.filter((p) => p.rejected_at).length;
      const shipped  = partials.filter((p) => p.shipment_id).length;
      const pending  = partials.length - rejected - shipped;
      parts.push(`${partials.length} parcial(es)`);
      if (shipped > 0)  parts.push(`${shipped} despachado(s)`);
      if (rejected > 0) parts.push(`${rejected} rechazado(s)`);
      if (pending > 0)  parts.push(`${pending} pendiente(s)`);
    }
    const assignCount = (l.assignments || []).length;
    if (assignCount > 0) {
      const pct = capacity > 0 ? Math.round((totalAllocated / capacity) * 100) : 0;
      parts.push(`${assignCount} pedido(s) · ${pct}%`);
    }
    return parts.length > 0 ? parts.join(' · ') : 'Sin parciales ni asignaciones';
  }

  function partialsSection(lot, partials) {
    const isDrying = lot.status === 'Drying';
    const isReady  = lot.status === 'Ready';
    const sumDried = partials.reduce((s, p) => s + Number(p.kg_dried || 0), 0);
    const sumGreen = partials.reduce((s, p) => s + Number(p.kg_green_yield || 0), 0);
    const usedLetters = new Set(partials.map((p) => p.parcial_letter));
    const fullySplit = usedLetters.size >= 6;

    const rows = partials.map((p) => {
      const isShipped = !!p.shipment_id;
      const isRejected = !!p.rejected_at;

      let statusBadge = null;
      if (isShipped) {
        statusBadge = el('span', { class: 'ctrm-pill ok', text: `En ${p.shipment_code || 'despacho'}` });
      } else if (isRejected) {
        statusBadge = el('span', { class: 'ctrm-pill urgency-red', text: 'Rechazado' });
      } else if (isReady) {
        statusBadge = el('span', { class: 'ctrm-pill', text: 'Pendiente' });
      }

      let action = null;
      if (isDrying && !isShipped && !isRejected) {
        action = el('button', {
          class: 'ctrm-btn ctrm-btn-ghost ctrm-btn-sm text-crit',
          title: 'Quitar parcial',
          onClick: () => removePartial(lot, p),
        }, ['×']);
      } else if (isReady && !isShipped) {
        action = isRejected
          ? el('button', {
              class: 'ctrm-btn ctrm-btn-ghost ctrm-btn-sm',
              title: 'Restaurar parcial',
              onClick: () => unrejectPartial(lot, p),
            }, ['Restaurar'])
          : el('button', {
              class: 'ctrm-btn ctrm-btn-ghost ctrm-btn-sm text-crit',
              title: 'Marcar como rechazado',
              onClick: () => rejectPartial(lot, p),
            }, ['Rechazar']);
      }

      return el('div', {
        class: `flex items-center justify-between gap-2 px-2 py-1.5 rounded-md border border-sand ${isRejected ? 'bg-cream opacity-70' : 'bg-cream'}`,
      }, [
        el('div', { class: 'flex items-center gap-2 min-w-0 flex-wrap' }, [
          el('span', { class: 'ctrm-pill dark', text: `Parcial ${p.parcial_letter}` }),
          el('span', { class: 'text-[11px] font-mono text-ink-700' }, [
            `${fmtKg(p.kg_dried)} seco · factor ${p.factor_rendimiento} → `,
            el('strong', { class: 'text-navy', text: fmtKg(p.kg_green_yield) }),
            ' verde',
          ]),
          statusBadge,
        ]),
        action,
      ]);
    });

    const activePartials = partials.filter((p) => !p.rejected_at);
    const sumGreenActive = activePartials.reduce((s, p) => s + Number(p.kg_green_yield || 0), 0);

    return el('div', { class: 'mt-3 border-t border-sand pt-2' }, [
      el('div', { class: 'flex items-center justify-between mb-1.5' }, [
        el('p', { class: 'eyebrow' }, [
          'Parciales',
          partials.length > 0
            ? el('span', { class: 'text-ink-500', text: ` · ${partials.length}/6` })
            : null,
        ]),
        isDrying ? el('button', {
          class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
          disabled: fullySplit ? 'true' : null,
          onClick: () => addPartial(lot),
        }, [fullySplit ? 'Sin letras disponibles' : '+ Agregar parcial']) : null,
      ]),
      partials.length > 0
        ? el('div', { class: 'space-y-1' }, rows)
        : el('p', { class: 'ctrm-hint', text: 'Aún no hay parciales. Registra cada uno al sacarlo del secadero.' }),
      partials.length > 0 ? el('div', {
        class: 'flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-ink-500 mt-2',
      }, [
        meta('Σ Seco',  fmtKg(sumDried)),
        meta('Σ Verde', fmtKg(sumGreen)),
        sumGreenActive !== sumGreen ? meta('Σ Verde activo', fmtKg(sumGreenActive)) : null,
      ]) : null,
    ]);
  }

  async function rejectPartial(lot, partial) {
    return openModal(({ close }) => {
      const reasonInput = el('textarea', {
        rows: '2', placeholder: 'Motivo (opcional)',
        class: 'ctrm-textarea',
      });
      return el('div', { class: 'space-y-3' }, [
        el('p', { class: 'text-[12px] text-ink-700' }, [
          `Rechazar parcial `, el('strong', { text: partial.parcial_letter }),
          ` de ${lot.bache_code || lot.lot_code} (${fmtKg(partial.kg_green_yield)} verde). ` +
          `No se incluirá en ningún despacho. Puedes restaurarlo después.`,
        ]),
        labelled('Motivo', reasonInput),
        el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
          el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
          el('button', {
            class: 'ctrm-btn ctrm-btn-danger',
            type: 'button',
            onClick: async () => {
              try {
                const r = await api.lotPartialReject({
                  partial_id: partial.id,
                  reason: reasonInput.value || null,
                });
                toast(`Parcial ${partial.parcial_letter} rechazado`, 'success', 3500, {
                  action: {
                    label: 'Deshacer',
                    onClick: async () => {
                      try {
                        await api.lotPartialReject({ partial_id: partial.id, undo: true });
                        toast(`Parcial ${partial.parcial_letter} restaurado`, 'success');
                        await reloadLots();
                      } catch (e) { toast(e.message, 'error'); }
                    },
                  },
                });
                close({ ok: true });
                if (r.over_allocation) await maybeRebalance(r.over_allocation);
                await reloadLots();
              } catch (e) { toast(e.message, 'error'); }
            },
          }, ['Rechazar parcial']),
        ]),
      ]);
    }, { title: `Rechazar parcial ${partial.parcial_letter}` });
  }

  async function maybeRebalance(over) {
    // Tras rechazar, el lote queda con asignaciones que exceden la
    // capacidad efectiva. Ofrecemos rebalanceo proporcional.
    const ok = await confirmModal(
      `Después de rechazar, las asignaciones del bache ${over.bache_code} ` +
      `(${fmtKg(over.total_allocated)}) exceden la capacidad efectiva ` +
      `(${fmtKg(over.capacity)}) por ${fmtKg(over.overflow)}. ` +
      `¿Reescalar proporcionalmente para que cuadren?`,
      { title: 'Asignaciones quedan sobre-asignadas', confirmText: 'Reescalar', danger: true },
    );
    if (!ok) {
      toast('Asignaciones sin ajustar — los pedidos pueden completarse con kg fantasma', 'warning', 5000);
      return;
    }
    const ratio = over.capacity / over.total_allocated;
    let okCount = 0; let errCount = 0;
    for (const a of over.assignments) {
      const newKg = Math.round(a.kg_green_allocated * ratio * 100) / 100;
      if (newKg <= 0) continue;
      try {
        await api.assignmentsUpdate({ assignment_id: a.id, kg_green_allocated: newKg });
        okCount++;
      } catch (e) {
        errCount++;
        // eslint-disable-next-line no-console
        console.warn('rebalance failed for', a.id, e.message);
      }
    }
    if (errCount === 0) toast(`${okCount} asignaciones reescaladas`, 'success');
    else toast(`${okCount} reescaladas, ${errCount} fallaron`, 'warning', 4500);
  }

  async function unrejectPartial(lot, partial) {
    const ok = await confirmModal(
      `Restaurar parcial ${partial.parcial_letter} de ${lot.bache_code || lot.lot_code}? Volverá a estar disponible para despacho.`,
      { title: 'Restaurar parcial' },
    );
    if (!ok) return;
    try {
      await api.lotPartialReject({ partial_id: partial.id, undo: true });
      toast(`Parcial ${partial.parcial_letter} restaurado`, 'success');
      await reloadLots();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function addPartial(lot) {
    const used = new Set((lot.partials || []).map((p) => p.parcial_letter));
    const available = ['A','B','C','D','E','F'].filter((x) => !used.has(x));
    if (available.length === 0) return;

    return openModal(({ close }) => {
      const letterSel = el('select', { class: 'ctrm-select' },
        available.map((L) => el('option', { value: L }, [`Parcial ${L}`])));
      const driedInput = el('input', {
        type: 'number', step: '0.01', min: '0', placeholder: 'Ej: 250',
        class: 'ctrm-input mono',
      });
      const factorInput = el('input', {
        type: 'number', step: '0.01', min: '0.01', placeholder: 'Ej: 145',
        class: 'ctrm-input mono',
      });
      const greenHint = el('p', { class: 'ctrm-hint', text: 'Verde = (peso seco ÷ factor) × 70' });
      const recompute = () => {
        const d = Number(driedInput.value || 0);
        const f = Number(factorInput.value || 0);
        if (d > 0 && f > 0) {
          greenHint.textContent = `Verde estimado: ${fmtKg(Math.round((d / f) * 70))}`;
        } else {
          greenHint.textContent = 'Verde = (peso seco ÷ factor) × 70';
        }
      };
      driedInput.addEventListener('input', recompute);
      factorInput.addEventListener('input', recompute);

      const notesInput = el('textarea', { rows: '2', class: 'ctrm-textarea' });

      return el('div', { class: 'space-y-3' }, [
        el('p', { class: 'text-[12px] text-ink-700' }, [
          `Bache `, el('strong', { text: lot.bache_code || lot.lot_code }),
          ' · ', el('span', { text: lot.reference_name || '' }),
        ]),
        labelled('Letra', letterSel),
        el('div', {}, [
          el('label', { class: 'ctrm-label', text: 'Peso seco (kg)' }),
          driedInput,
        ]),
        el('div', {}, [
          el('label', { class: 'ctrm-label', text: 'Factor de rendimiento' }),
          factorInput,
          greenHint,
        ]),
        labelled('Notas (opcional)', notesInput),
        el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
          el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
          el('button', {
            class: 'ctrm-btn ctrm-btn-primary',
            type: 'button',
            onClick: async () => {
              const d = Number(driedInput.value);
              const f = Number(factorInput.value);
              if (!(d > 0)) { toast('Peso seco inválido', 'warning'); return; }
              if (!(f > 0)) { toast('Factor inválido', 'warning'); return; }
              try {
                await api.lotPartialCreate({
                  production_lot_id: lot.id,
                  parcial_letter: letterSel.value,
                  kg_dried: d,
                  factor_rendimiento: f,
                  notes: notesInput.value || null,
                });
                toast(`Parcial ${letterSel.value} registrado`, 'success');
                close({ ok: true });
                await reloadLots();
              } catch (e) { toast(e.message, 'error'); }
            },
          }, ['Registrar parcial']),
        ]),
      ]);
    }, { title: 'Registrar parcial' });
  }

  async function removePartial(lot, partial) {
    const ok = await confirmModal(
      `Quitar parcial ${partial.parcial_letter} (${fmtKg(partial.kg_dried)} seco) del bache ${lot.bache_code || lot.lot_code}?`,
      { title: 'Quitar parcial', confirmText: 'Quitar', danger: true },
    );
    if (!ok) return;
    try {
      await api.lotPartialDelete({ partial_id: partial.id });
      toast(`Parcial ${partial.parcial_letter} eliminado`, 'success');
      await reloadLots();
    } catch (e) { toast(e.message, 'error'); }
  }

  // Single assignment row — shows kg + % of lot + Editar/Quitar.
  function assignmentRow(a, lot, capacity) {
    const kg  = Number(a.kg_green_allocated || 0);
    const pct = capacity > 0 ? (kg / capacity * 100) : null;
    const pctClass = pct == null ? 'text-ink-500'
                   : pct > 100 ? 'text-crit font-bold'
                   : 'text-ink-500';

    // Inline-edit del kg: input number que guarda al blur o Enter.
    // Si no hay cambio o es invalido, no hace nada.
    const kgInput = el('input', {
      type: 'number', min: '0', step: '0.01',
      value: String(kg),
      class: 'ctrm-input mono w-24 text-right py-0.5 px-1.5 text-[11px]',
      style: 'min-height:28px;',
    });
    const commitKg = async () => {
      const newKg = Number(kgInput.value);
      if (!Number.isFinite(newKg) || newKg <= 0) {
        kgInput.value = String(kg);
        return;
      }
      if (Math.abs(newKg - kg) < 0.005) return;   // sin cambio efectivo
      try {
        await api.assignmentsUpdate({ assignment_id: a.id, kg_green_allocated: newKg });
        toast(`Asignación a ${a.order?.order_code || ''} ajustada a ${fmtKg(newKg)}`, 'success');
        await reloadLots();
      } catch (e) {
        toast(e.message, 'error');
        kgInput.value = String(kg);   // revertir UI
      }
    };
    kgInput.addEventListener('blur', commitKg);
    kgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); kgInput.blur(); }
      if (e.key === 'Escape') { kgInput.value = String(kg); kgInput.blur(); }
    });

    return el('div', { class: 'flex flex-wrap items-center justify-between text-[11px] gap-2 py-1' }, [
      el('div', { class: 'flex items-center gap-2 min-w-0' }, [
        el('span', { class: 'ctrm-code', text: a.order?.order_code || a.demand_order_id }),
        el('span', { class: 'text-ink-500', text: a.order?.status ? statusLabel(a.order.status) : '' }),
      ]),
      el('div', { class: 'flex items-center gap-2' }, [
        kgInput,
        pct != null ? el('span', { class: `font-mono text-[10px] ${pctClass}` }, [`${pct.toFixed(0)}%`]) : null,
        el('button', {
          class: 'text-crit hover:underline text-[11px]',
          onClick: () => removeAssignment(a, lot),
        }, ['Quitar']),
      ]),
    ]);
  }

  // ---------- Edit a single assignment's kg ----------
  async function editAssignment(assignment, lot) {
    const capacity = Number(lot.kg_green_actual ?? lot.kg_green_expected ?? 0);
    const otherSum = (lot.assignments || [])
      .filter((x) => x.id !== assignment.id)
      .reduce((s, x) => s + Number(x.kg_green_allocated || 0), 0);
    const maxAllowed = Math.max(0, capacity - otherSum);

    const result = await openModal(({ close }) => {
      const input = el('input', {
        type: 'number', step: '0.01', min: '0.01',
        value: String(assignment.kg_green_allocated),
        class: 'ctrm-input mono',
      });
      const hint = el('p', { class: 'ctrm-hint', text: '' });
      const recompute = () => {
        const v = Number(input.value || 0);
        const newPct = capacity > 0 ? (v / capacity * 100).toFixed(1) : '—';
        hint.textContent = `Máximo permitido: ${fmtKg(maxAllowed)}  ·  Esto sería ${newPct}% del lote`;
      };
      input.addEventListener('input', recompute);
      recompute();

      return el('div', { class: 'space-y-3' }, [
        el('div', { class: 'rounded-lg bg-cream border border-sand p-3 text-[12px] space-y-1' }, [
          el('div', {}, [`Pedido: `, el('strong', { text: assignment.order?.order_code || '—' })]),
          el('div', {}, [`Lote: `,   el('strong', { text: lot.bache_code || lot.lot_code })]),
          el('div', {}, [`Capacidad lote: `, el('strong', { text: fmtKg(capacity) })]),
          el('div', {}, [`Otras asignaciones: `, el('strong', { text: fmtKg(otherSum) })]),
        ]),
        el('label', { class: 'ctrm-label', text: 'kg verde a asignar' }),
        input,
        hint,
        el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
          el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
          el('button', {
            class: 'ctrm-btn ctrm-btn-primary',
            type: 'button',
            onClick: () => {
              const v = Number(input.value);
              if (!Number.isFinite(v) || v <= 0) { toast('kg debe ser > 0', 'warning'); return; }
              close({ kg: v });
            },
          }, ['Guardar']),
        ]),
      ]);
    }, { title: `Editar asignación ${assignment.order?.order_code || ''}` });

    if (!result) return;
    try {
      await api.assignmentsUpdate({ assignment_id: assignment.id, kg_green_allocated: result.kg });
      toast('Asignación actualizada', 'success');
      await reloadLots();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- Rescale all assignments proportionally ----------
  async function rescaleAssignments(lot, capacity, currentTotal) {
    if (currentTotal <= 0 || capacity <= 0) { toast('Nada para reescalar', 'warning'); return; }
    const ratio = capacity / currentTotal;
    const ok = await confirmModal(
      `Cada asignación se multiplicará por ${ratio.toFixed(4)} para que sumen exactamente ${fmtKg(capacity)}. ¿Continuar?`,
      { title: 'Ajustar proporcionalmente', confirmText: 'Ajustar' },
    );
    if (!ok) return;

    // Update each assignment. Decreases pass freely (the trigger only blocks increases).
    let okCount = 0; let errCount = 0;
    for (const a of lot.assignments || []) {
      const newKg = Math.round(Number(a.kg_green_allocated || 0) * ratio * 100) / 100;
      if (newKg <= 0) continue;
      try {
        await api.assignmentsUpdate({ assignment_id: a.id, kg_green_allocated: newKg });
        okCount++;
      } catch (e) {
        errCount++;
        // eslint-disable-next-line no-console
        console.warn('rescale failed for', a.id, e.message);
      }
    }
    if (errCount === 0) {
      toast(`${okCount} asignaciones ajustadas`, 'success');
    } else {
      toast(`${okCount} ajustadas, ${errCount} fallaron`, 'warning', 4500);
    }
    await reloadLots();
  }

  async function advanceStatus(lot, target) {
    let yieldValues = null;
    let dryingStartDate = null;
    const partials = lot.partials || [];
    const hasPartials = partials.length > 0;

    // Drying → Ready con parciales: el servidor suma los rendimientos.
    // No se pide peso seco ni factor; solo confirmamos.
    if (target === 'Ready' && hasPartials) {
      const sumDried = partials.reduce((s, p) => s + Number(p.kg_dried || 0), 0);
      const sumGreen = partials.reduce((s, p) => s + Number(p.kg_green_yield || 0), 0);
      const ok = await confirmModal(
        `Cerrar bache ${lot.bache_code || lot.lot_code} con ${partials.length} parcial(es)? ` +
        `Total: ${fmtKg(sumDried)} seco · ${fmtKg(sumGreen)} verde.`,
        { title: 'Cerrar bache' },
      );
      if (!ok) return;
    } else if (target === 'Ready' || target === 'Delivered') {
      yieldValues = await promptYield(lot, target);
      if (yieldValues === undefined) return;
    } else if (target === 'Drying') {
      dryingStartDate = await promptDryingStartDate(lot);
      if (dryingStartDate === undefined) return;
    } else {
      const ok = await confirmModal(`Avanzar ${lot.bache_code || lot.lot_code} a "${statusLabel(target)}"?`, { title: 'Cambio de estado' });
      if (!ok) return;
    }
    try {
      const payload = { lot_id: lot.id, status: target };
      if (dryingStartDate) payload.drying_start_date = dryingStartDate;
      if (yieldValues) {
        if (yieldValues.kg_dried_output    != null) payload.kg_dried_output    = yieldValues.kg_dried_output;
        if (yieldValues.factor_rendimiento != null) payload.factor_rendimiento = yieldValues.factor_rendimiento;
        if (yieldValues.kg_green_actual    != null) payload.kg_green_actual    = yieldValues.kg_green_actual;
      }
      const r = await api.lotUpdateStatus(payload);
      toast(`${lot.bache_code || lot.lot_code} → ${statusLabel(target)}`, 'success');
      if (r.completions && r.completions.length > 0) {
        toast(`${r.completions.length} pedido(s) completado(s)`, 'success', 4500);
      }
      await reloadLots();
    } catch (e) { toast(e.message, 'error'); }
  }

  function promptDryingStartDate(lot) {
    return openModal(({ close }) => {
      const defaultDate = lot.drying_start_date || new Date().toISOString().slice(0, 10);
      const dateInput = el('input', {
        type: 'date',
        value: defaultDate,
        class: 'ctrm-input',
      });
      return el('div', { class: 'space-y-3' }, [
        el('p', { class: 'text-[12px] text-ink-700 leading-relaxed' }, [
          `Avanzando `, el('strong', { class: 'text-navy', text: lot.bache_code || lot.lot_code }),
          ` a `, el('strong', { class: 'text-navy', text: 'Drying' }),
          `. La fecha de inicio de secado se usa para calcular el avance del lote.`,
        ]),
        el('label', { class: 'ctrm-label', text: 'Fecha de inicio de secado' }),
        dateInput,
        el('p', { class: 'ctrm-hint', text: 'Por defecto hoy; cámbialo si el bache empezó otro día.' }),
        el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
          el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(undefined) }, ['Cancelar']),
          el('button', {
            class: 'ctrm-btn ctrm-btn-primary',
            type: 'button',
            onClick: () => {
              if (!dateInput.value) { toast('Selecciona una fecha', 'warning'); return; }
              close(dateInput.value);
            },
          }, ['Avanzar a Drying']),
        ]),
      ]);
    }, { title: 'Inicio de secado' });
  }

  function promptYield(lot, target) {
    return openModal(({ close }) => {
      const driedInput = el('input', {
        type: 'number', step: '0.01', min: '0',
        value: lot.kg_dried_output != null ? String(lot.kg_dried_output) : '',
        placeholder: 'Ej: 1000',
        class: 'ctrm-input mono',
      });
      const factorInput = el('input', {
        type: 'number', step: '0.01', min: '0.01',
        value: lot.factor_rendimiento != null ? String(lot.factor_rendimiento) : '',
        placeholder: 'Ej: 145',
        class: 'ctrm-input mono',
      });
      const greenInput = el('input', {
        type: 'number', step: '0.01', min: '0',
        value: lot.kg_green_actual != null ? String(lot.kg_green_actual) : '',
        placeholder: 'Auto desde peso seco / factor',
        class: 'ctrm-input mono',
      });
      const formula = el('p', { class: 'ctrm-hint', text: `Verde = (peso seco ÷ factor) × ${KG_PER_SACO}` });
      let greenManuallyEdited = lot.kg_green_actual != null;

      const recompute = () => {
        if (greenManuallyEdited) return;
        const seco = Number(driedInput.value || 0);
        const fac  = Number(factorInput.value || 0);
        if (seco > 0 && fac > 0) {
          greenInput.value = String(Math.round((seco / fac) * KG_PER_SACO));
        } else {
          greenInput.value = '';
        }
      };
      driedInput.addEventListener('input', recompute);
      factorInput.addEventListener('input', recompute);
      greenInput.addEventListener('input', () => { greenManuallyEdited = greenInput.value !== ''; });

      return el('div', { class: 'space-y-3' }, [
        el('p', { class: 'text-[12px] text-ink-700 leading-relaxed' }, [
          `Avanzando ${lot.bache_code || lot.lot_code} a `, el('strong', { class: 'text-navy', text: statusLabel(target) }),
          '. Registra peso seco y factor de rendimiento; el verde se calcula automáticamente.',
        ]),
        el('label', { class: 'ctrm-label', text: 'Peso seco (kg)' }),
        driedInput,
        el('label', { class: 'ctrm-label mt-2', text: 'Factor de rendimiento' }),
        factorInput,
        formula,
        el('label', { class: 'ctrm-label mt-2', text: 'kg verde reales' }),
        greenInput,
        el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
          el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(undefined) }, ['Cancelar']),
          el('button', {
            class: 'ctrm-btn ctrm-btn-primary',
            type: 'button',
            onClick: () => {
              const dried  = driedInput.value  === '' ? null : Number(driedInput.value);
              const factor = factorInput.value === '' ? null : Number(factorInput.value);
              const green  = greenInput.value  === '' ? null : Number(greenInput.value);
              if (dried  != null && !(dried >= 0))  { toast('Peso seco inválido', 'warning'); return; }
              if (factor != null && !(factor > 0))  { toast('Factor inválido (> 0)', 'warning'); return; }
              if (green  != null && !(green >= 0))  { toast('kg verde inválido', 'warning'); return; }
              close({ kg_dried_output: dried, factor_rendimiento: factor, kg_green_actual: green });
            },
          }, ['Confirmar']),
        ]),
      ]);
    }, { title: `Cambiar estado a ${statusLabel(target)}` });
  }

  async function removeAssignment(assignment, lot) {
    const ok = await confirmModal(`Quitar asignación de ${fmtKg(assignment.kg_green_allocated)} al pedido ${assignment.order?.order_code || ''}?`, {
      title: 'Quitar asignación', confirmText: 'Quitar', danger: true,
    });
    if (!ok) return;
    try {
      await api.assignmentsDelete({ assignment_id: assignment.id });
      // Snapshot pre-borrado para reconstruir si el usuario quiere deshacer.
      const snap = {
        production_lot_id: lot.id,
        demand_order_id:   assignment.demand_order_id,
        kg_green_allocated: Number(assignment.kg_green_allocated || 0),
        order_code:         assignment.order?.order_code || '',
      };
      toast('Asignación eliminada', 'success', 3500, {
        action: {
          label: 'Deshacer',
          onClick: async () => {
            try {
              await api.assignmentsCreate({
                production_lot_id: snap.production_lot_id,
                assignments: [{
                  demand_order_id:    snap.demand_order_id,
                  kg_green_allocated: snap.kg_green_allocated,
                }],
              });
              toast(`Asignación al pedido ${snap.order_code} restaurada`, 'success');
              await reloadLots();
            } catch (e) { toast(e.message, 'error'); }
          },
        },
      });
      await reloadLots();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function reloadLots() {
    const r = await api.lotsList({ active_only: 'true' });
    lots = r.lots;
    render();
  }

  // ---------- Edit bache code ----------
  function editBacheCode(lot) {
    return openModal(({ close }) => {
      const inp = el('input', {
        type: 'text', value: lot.bache_code || '',
        class: 'ctrm-input mono uppercase',
        maxlength: '60',
      });
      return el('div', { class: 'space-y-3' }, [
        el('p', { class: 'text-[12px] text-ink-500' }, [
          `Lote interno: `, el('strong', { class: 'font-mono text-ink-700', text: lot.lot_code }),
        ]),
        labelled('Código de bache', inp),
        el('p', { class: 'ctrm-hint', text: 'Único entre todos los lotes.' }),
        el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
          el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
          el('button', {
            class: 'ctrm-btn ctrm-btn-primary',
            type: 'button',
            onClick: async () => {
              const v = inp.value.trim();
              if (!v) { toast('Código requerido', 'warning'); return; }
              if (v === lot.bache_code) { close(null); return; }
              try {
                await api.lotUpdate({ lot_id: lot.id, fields: { bache_code: v } });
                toast(`Código actualizado a ${v}`, 'success');
                close({ ok: true });
                await reloadLots();
              } catch (e) { toast(e.message, 'error'); }
            },
          }, ['Guardar']),
        ]),
      ]);
    }, { title: 'Editar código de bache' });
  }

  // ---------- Create lot (stage selector + optional pre-assignment) ----------
  function createLot() {
    return openModal(({ close }) => {
      let chosenRef = null;
      let chosenStage = 'cereza';
      let candidateOrders = [];      // lazy-loaded when reference + process settle
      const assignmentInputs = new Map();   // order_id → input element

      const bacheInput = el('input', {
        type: 'text', placeholder: 'Ej: B-23, BACHE-2026-04',
        class: 'ctrm-input mono uppercase',
        maxlength: '60', required: 'true',
      });

      const refCombo = createCombobox({
        placeholder: 'Buscar referencia...',
        items: refs,
        onChange: (item) => {
          chosenRef = item;
          if (item?.process_type) procSelect.value = item.process_type;
          if (item?.fermentation_hours != null && fermInput.value === '') {
            fermInput.value = String(item.fermentation_hours);
          }
          maybeRefreshCandidates();
        },
        onCreate: async (text) => {
          const name = (text || '').trim();
          if (!name) return null;
          try {
            const r = await api.referenceSave({
              name,
              process_type: procSelect.value || null,
              fermentation_hours: fermInput.value === '' ? null : Number(fermInput.value),
            });
            toast(`Referencia "${r.reference.name}" lista`, 'success');
            // Append to local list y refrescar el combo
            if (!refs.some((x) => x.id === r.reference.id)) {
              refs.push(r.reference);
              refs.sort((a, b) => a.name.localeCompare(b.name));
              refCombo.setItems(refs);
            }
            return r.reference;
          } catch (e) { toast(e.message, 'error'); return null; }
        },
        createLabel: '+ Usar este nombre como nueva referencia',
      });

      const procSelect = el('select', { class: 'ctrm-select' }, [
        el('option', { value: '', disabled: true, selected: true }, ['Selecciona proceso...']),
        ...PROCESS_TYPES.map((p) => el('option', { value: p }, [p])),
      ]);
      procSelect.addEventListener('change', () => maybeRefreshCandidates());

      // Tipo de café — segmented control. min-w-0 + text wrap por si la
      // pantalla es muy angosta (mobile <340px) para no desbordar la card.
      const stageButtons = STAGE_OPTIONS.map((opt) => el('button', {
        type: 'button',
        class: `ctrm-btn flex-1 min-w-0 uppercase tracking-eyebrow text-[10px] px-2 ${opt.value === chosenStage ? 'ctrm-btn-primary' : 'ctrm-btn-soft'}`,
        style: 'white-space:normal;line-height:1.15;',
        onClick: () => { chosenStage = opt.value; refreshStageUI(); },
      }, [opt.label]));

      const kgInput = el('input', {
        type: 'number', min: '0', step: '0.01',
        class: 'ctrm-input mono',
      });
      const kgLabelEl = el('label', { class: 'ctrm-label', text: stageInputLabelOf(chosenStage) });
      const kgGreenHint = el('p', { class: 'ctrm-hint', text: stageHintEmpty(chosenStage) });
      const recomputeGreen = () => {
        const v = Number(kgInput.value || 0);
        const div = INPUT_STAGE_DIVISORS[chosenStage];
        kgGreenHint.textContent = v > 0
          ? `Verde esperado: ${fmtKg(v / div)}  (÷ ${div.toFixed(2)})`
          : stageHintEmpty(chosenStage);
      };
      kgInput.addEventListener('input', recomputeGreen);

      function refreshStageUI() {
        stageButtons.forEach((btn, i) => {
          const opt = STAGE_OPTIONS[i];
          btn.className = `ctrm-btn flex-1 uppercase tracking-eyebrow text-[10px] ${opt.value === chosenStage ? 'ctrm-btn-primary' : 'ctrm-btn-soft'}`;
        });
        kgLabelEl.textContent = stageInputLabelOf(chosenStage);
        recomputeGreen();
      }

      const startInput = el('input', {
        type: 'date', value: new Date().toISOString().slice(0, 10),
        class: 'ctrm-input',
      });

      const fermInput = el('input', {
        type: 'number', min: '0', step: '0.5', placeholder: 'Opcional',
        class: 'ctrm-input mono',
      });

      const vCombo = createMultiCombobox({
        placeholder: 'Variedades...',
        items: allVarieties,
        onCreate: async (text) => {
          try {
            const r = await api.varietyAdd(text);
            toast(`Variedad creada: ${r.variety.name}`, 'success');
            return r.variety;
          } catch (e) { toast(e.message, 'error'); return null; }
        },
        createLabel: '+ Crear variedad',
      });

      // Infusion: combobox opcional + input % que aparece solo cuando
      // hay infusion elegida. La masa base para el calculo es el kg
      // del stage de entrada (kgInput).
      let chosenInfusion = null;
      const infusionPctInput = el('input', {
        type: 'number', min: '0.5', step: '0.5', max: '100',
        placeholder: '% sobre el peso de entrada',
        class: 'ctrm-input mono',
      });
      const infusionHint = el('p', { class: 'ctrm-hint mt-1' });
      const refreshInfusionHint = () => {
        const pct = Number(infusionPctInput.value || 0);
        const base = Number(kgInput.value || 0);
        if (!chosenInfusion) {
          infusionHint.textContent = 'Opcional. Si se llena, también pide el % sobre el peso de entrada.';
        } else if (pct > 0 && base > 0) {
          const insumo = Math.round((base * pct / 100) * 100) / 100;
          infusionHint.textContent = `${chosenInfusion.name} ${pct}% sobre ${fmtKg(base)} → ${fmtKg(insumo)} de insumo`;
        } else {
          infusionHint.textContent = `${chosenInfusion.name}: ingresa el % para ver la cantidad de insumo.`;
        }
      };
      infusionPctInput.addEventListener('input', refreshInfusionHint);
      const infusionWrap = el('div', { hidden: 'true' }, [
        el('label', { class: 'ctrm-label', text: '% sobre el peso de entrada' }),
        infusionPctInput,
        infusionHint,
      ]);
      const infusionCombo = createCombobox({
        placeholder: 'Buscar infusión... (opcional)',
        items: allInfusions,
        onChange: (item) => {
          chosenInfusion = item || null;
          if (chosenInfusion) infusionWrap.removeAttribute('hidden');
          else {
            infusionWrap.setAttribute('hidden', 'true');
            infusionPctInput.value = '';
          }
          refreshInfusionHint();
        },
        onCreate: async (name) => {
          try {
            const r = await api.infusionAdd(name.trim());
            allInfusions = [...allInfusions, r.infusion]
              .sort((a, b) => a.name.localeCompare(b.name));
            infusionCombo.setItems(allInfusions);
            toast(`Infusión "${r.infusion.name}" lista`, 'success');
            return r.infusion;
          } catch (e) { toast(e.message, 'error'); return null; }
        },
        createLabel: '+ Crear infusión',
      });
      refreshInfusionHint();
      // Si cambia kgInput, recalcular el hint
      kgInput.addEventListener('input', refreshInfusionHint);

      const notesInput = el('textarea', {
        rows: '2',
        class: 'ctrm-textarea',
      });

      // Optional assignments section
      const assignWrap = el('div', { class: 'space-y-1.5' }, [
        el('p', { class: 'ctrm-hint', text: 'Selecciona referencia + proceso para ver pedidos compatibles.' }),
      ]);

      async function maybeRefreshCandidates() {
        if (!chosenRef || !procSelect.value) {
          assignWrap.innerHTML = '';
          assignWrap.append(el('p', { class: 'ctrm-hint', text: 'Selecciona referencia + proceso para ver pedidos compatibles.' }));
          return;
        }
        try {
          // Trae todos los lots (incluyendo Delivered) para que el
          // remaining_kg del pedido refleje las asignaciones que ya
          // se cubrieron desde lotes pasados.
          const [r, allLotsRes] = await Promise.all([
            api.ordersList({
              status: 'Accepted,PartiallyAccepted,InProduction,Completed',
              reference_id: chosenRef.id,
              process_type: procSelect.value,
            }),
            api.lotsList({}),
          ]);
          const allLots = allLotsRes.lots || [];
          const allocByOrder = new Map();
          for (const ll of allLots) {
            for (const a of ll.assignments || []) {
              allocByOrder.set(a.demand_order_id, (allocByOrder.get(a.demand_order_id) || 0) + Number(a.kg_green_allocated || 0));
            }
          }
          candidateOrders = (r.orders || []).map((o) => {
            const allocated = allocByOrder.get(o.id) || 0;
            const remaining = Math.max(0, Number(o.kg_green_accepted || 0) - allocated);
            return { ...o, allocated_kg: allocated, remaining_kg: remaining };
          });
          // Aun con remaining = 0 el pedido es candidato (se asigna como excedente).
          renderCandidates();
        } catch (e) {
          assignWrap.innerHTML = '';
          assignWrap.append(el('p', { class: 'text-[12px] text-crit', text: e.message }));
        }
      }

      function renderCandidates() {
        assignWrap.innerHTML = '';
        assignmentInputs.clear();
        if (candidateOrders.length === 0) {
          assignWrap.append(el('p', { class: 'ctrm-hint', text: 'No hay pedidos compatibles con kg disponibles.' }));
          return;
        }
        for (const o of candidateOrders) {
          const inp = el('input', {
            type: 'number', step: '0.01', min: '0', max: String(o.remaining_kg),
            placeholder: '0',
            class: 'ctrm-input mono w-24 text-right py-1',
          });
          assignmentInputs.set(o.id, inp);
          assignWrap.append(el('div', { class: 'flex flex-wrap items-center justify-between gap-2 py-1.5 border-b border-sand last:border-b-0' }, [
            el('div', { class: 'min-w-0 flex-1' }, [
              el('div', { class: 'flex items-center gap-2 mb-0.5' }, [
                el('span', { class: 'ctrm-code', text: o.order_code }),
                el('span', { class: 'text-[12px] text-ink-700 truncate', text: o.reference_name || '' }),
              ]),
              el('div', { class: 'text-[11px] text-ink-500 font-mono' }, [
                `Aceptado ${fmtKg(o.kg_green_accepted)} · Asignado ${fmtKg(o.allocated_kg)} · `,
                el('strong', { class: 'text-ink-700' }, [`Disponible ${fmtKg(o.remaining_kg)}`]),
                ` · Entrega ${fmtDate(o.max_delivery_date)}`,
              ]),
            ]),
            inp,
          ]));
        }
        assignWrap.append(el('p', { class: 'ctrm-hint mt-2', text: 'Opcional: indica cuántos kg verde de este lote se asignan a cada pedido. Se puede ajustar después.' }));
      }

      const body = el('div', { class: 'space-y-3' }, [
        el('div', {}, [
          el('label', { class: 'ctrm-label' }, [
            'Código de bache ',
            el('span', { class: 'ctrm-req', text: '*' }),
          ]),
          bacheInput,
          el('p', { class: 'ctrm-hint', text: 'Único por lote. La finca lo asigna a la llegada de la cereza.' }),
        ]),
        labelled('Referencia', refCombo.el),
        labelled('Proceso', procSelect),

        // Stage selector
        el('div', {}, [
          el('label', { class: 'ctrm-label', text: 'Tipo de café' }),
          el('div', { class: 'flex gap-2' }, stageButtons),
        ]),

        // kg input + auto green hint
        el('div', {}, [
          kgLabelEl,
          kgInput,
          kgGreenHint,
        ]),

        labelled('Fecha de inicio', startInput),
        labelled('Horas de fermentación', fermInput),
        labelled('Variedades', vCombo.el),
        el('div', {}, [
          el('label', { class: 'ctrm-label', text: 'Infusión (opcional)' }),
          infusionCombo.el,
        ]),
        infusionWrap,
        labelled('Notas', notesInput),

        // Optional pre-assignment
        el('div', { class: 'pt-3 border-t border-sand' }, [
          el('label', { class: 'ctrm-label', text: 'Asignar a pedidos (opcional)' }),
          el('div', { class: 'max-h-[40vh] overflow-y-auto' }, [assignWrap]),
        ]),

        el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
          el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
          el('button', {
            class: 'ctrm-btn ctrm-btn-primary',
            type: 'button',
            onClick: async () => {
              const bacheCode = bacheInput.value.trim();
              if (!bacheCode) { toast('Falta código de bache', 'warning'); return; }
              if (!chosenRef) { toast('Selecciona referencia', 'warning'); return; }
              if (!procSelect.value) { toast('Selecciona proceso', 'warning'); return; }
              const kg = Number(kgInput.value);
              if (!(kg > 0)) { toast(`${stageInputLabelOf(chosenStage)}: valor inválido`, 'warning'); return; }
              if (!startInput.value) { toast('Falta fecha de inicio', 'warning'); return; }

              // Collect assignments (filter out empty / zero rows)
              const initial_assignments = [];
              for (const [orderId, inp] of assignmentInputs) {
                const v = Number(inp.value || 0);
                if (v > 0) initial_assignments.push({ demand_order_id: orderId, kg_green_allocated: v });
              }

              // Local validation: total allocations ≤ kg verde esperado
              const greenExpected = kg / INPUT_STAGE_DIVISORS[chosenStage];
              const totalAlloc = initial_assignments.reduce((s, a) => s + a.kg_green_allocated, 0);
              if (totalAlloc > greenExpected + 0.001) {
                toast(`Asignaciones (${fmtKg(totalAlloc)}) exceden verde esperado (${fmtKg(greenExpected)})`, 'warning', 4500);
                return;
              }

              // Validacion infusion: si hay infusion, debe haber pct > 0
              const infusionPct = chosenInfusion ? Number(infusionPctInput.value) : null;
              if (chosenInfusion && (!Number.isFinite(infusionPct) || infusionPct <= 0 || infusionPct > 100)) {
                toast('Infusión: indica un % entre 0 y 100', 'warning');
                return;
              }

              try {
                const r = await api.lotCreate({
                  bache_code: bacheCode,
                  reference_id: chosenRef.id,
                  process_type: procSelect.value,
                  processing_stage: chosenStage,
                  kg_input_amount: kg,
                  start_date: startInput.value,
                  fermentation_hours: fermInput.value === '' ? null : Number(fermInput.value),
                  variety_ids: vCombo.getValues().map((v) => v.id),
                  notes: notesInput.value || null,
                  infusion_id: chosenInfusion ? chosenInfusion.id : null,
                  infusion_pct: chosenInfusion ? infusionPct : null,
                  initial_assignments,
                });
                const assignedCount = (r.assignments || []).length;
                toast(`Lote ${r.lot.bache_code || r.lot.lot_code} creado${assignedCount ? ` · ${assignedCount} pedido(s) asignado(s)` : ''}`, 'success');
                close({ ok: true });
                await reloadLots();
              } catch (e) { toast(e.message, 'error'); }
            },
          }, ['Crear lote']),
        ]),
      ]);

      refreshStageUI();
      return body;
    }, { title: 'Nuevo lote', wide: true });
  }

  // ---------- Assign lot to orders (post-creation) ----------
  async function assignLot(lot) {
    let candidates = [];
    try {
      // Pedimos las orders compatibles + TODOS los lots (incluyendo
      // Delivered) para que allocByOrder cuente las asignaciones que
      // ya cubrieron parte del pedido desde lotes ya entregados. Sin
      // esto, remaining_kg sale inflado y el trigger de la BD rechaza
      // la nueva asignacion por sobrecupo.
      const [r, allLotsRes] = await Promise.all([
        api.ordersList({
          status: 'Accepted,PartiallyAccepted,InProduction,Completed',
          reference_id: lot.reference_id,
          process_type: lot.process_type,
        }),
        api.lotsList({}),
      ]);
      const allLots = allLotsRes.lots || [];
      const allocByOrder = new Map();
      for (const ll of allLots) {
        for (const a of ll.assignments || []) {
          allocByOrder.set(a.demand_order_id, (allocByOrder.get(a.demand_order_id) || 0) + Number(a.kg_green_allocated || 0));
        }
      }
      candidates = r.orders.map((o) => {
        const allocated = allocByOrder.get(o.id) || 0;
        const accepted = Number(o.kg_green_accepted || 0);
        const remaining = Math.max(0, accepted - allocated);
        return { ...o, allocated_kg: allocated, remaining_kg: remaining };
      });
      // No filtramos por remaining > 0: aun con el pedido al 100%
      // se puede asignar el resto del lote como excedente.
    } catch (e) { toast(e.message, 'error'); return; }

    if (candidates.length === 0) {
      toast('No hay pedidos compatibles con kg disponibles para este lote.', 'warning', 4500);
      return;
    }

    const result = await openModal(({ close }) => assignModalBody(lot, candidates, close), {
      title: `Asignar lote ${lot.bache_code || lot.lot_code}`, wide: true,
    });
    if (!result) return;

    const assignments = result.assignments.filter((a) => Number(a.kg_green_allocated) > 0);
    if (assignments.length === 0) { toast('Sin kg para asignar.', 'warning'); return; }

    try {
      await api.assignmentsCreate({
        production_lot_id: lot.id,
        assignments: assignments.map((a) => ({
          demand_order_id: a.demand_order_id,
          kg_green_allocated: Number(a.kg_green_allocated),
        })),
      });
      toast('Asignaciones creadas', 'success');
      await reloadLots();
    } catch (e) { toast(e.message, 'error'); }
  }
}

// ───────────────────── helpers ──────────────────────
// Pill de infusion para mostrar en cards/tablas. Tooltip incluye la
// cantidad estimada de insumo segun el peso del stage de entrada.
function infusionPill(lot) {
  if (!lot.infusion_id || !lot.infusion_pct) return null;
  const name = lot.infusion_name || 'Infusión';
  const pct  = Number(lot.infusion_pct);
  const baseKg = Number(lot.kg_cherry_input ?? lot.kg_despulpado_input ?? lot.kg_dried_output ?? 0);
  const insumo = baseKg > 0 ? Math.round(baseKg * pct / 100 * 100) / 100 : 0;
  const tooltip = baseKg > 0
    ? `${name} ${pct}% sobre ${fmtKg(baseKg)} → ${fmtKg(insumo)} de insumo`
    : `${name} ${pct}%`;
  return el('span', {
    class: 'ctrm-pill',
    style: 'background:#fbe6c2;color:#8a5100;',
    title: tooltip,
    text: `${name} ${pct}%`,
  });
}

function stageLabelOf(lot) {
  if (lot.processing_stage === 'cereza')     return 'Inicio: cereza';
  if (lot.processing_stage === 'despulpado') return 'Inicio: despulpado';
  if (lot.processing_stage === 'seco')       return 'Inicio: seco';
  return null;
}

function stageInputLabelOf(stage) {
  return (STAGE_OPTIONS.find((s) => s.value === stage) || {}).inputLabel || 'kg de café';
}

function stageHintEmpty(stage) {
  const div = INPUT_STAGE_DIVISORS[stage];
  return `Verde esperado: ÷ ${div.toFixed(2)}`;
}

function meta(label, value) {
  return el('span', { class: 'inline-flex items-baseline gap-1' }, [
    el('span', { class: 'text-ink-300 uppercase tracking-loose text-[10px] font-sans font-semibold', text: label }),
    el('strong', { class: 'text-ink-700 font-mono', text: value }),
  ]);
}

function metaColor(label, value, kind) {
  return el('span', { class: 'inline-flex items-baseline gap-1' }, [
    el('span', { class: 'text-ink-300 uppercase tracking-loose text-[10px] font-sans font-semibold', text: label }),
    el('strong', { class: `font-mono font-bold ${kind === 'crit' ? 'text-crit' : 'text-ink-700'}`, text: value }),
  ]);
}

function labelled(label, child) {
  return el('div', {}, [
    el('label', { class: 'ctrm-label', text: label }),
    child,
  ]);
}

function assignModalBody(lot, candidates, close) {
  const totalLotAvail = Number(lot.kg_green_actual ?? lot.kg_green_expected);
  const totalLotAllocated = (lot.assignments || []).reduce((s, a) => s + Number(a.kg_green_allocated || 0), 0);
  const lotRemaining = Math.max(0, totalLotAvail - totalLotAllocated);

  const inputs = new Map();
  const totalEl = el('strong', { class: 'font-mono text-navy', text: '0' });
  const remEl   = el('strong', { class: 'font-mono', text: fmtKg(lotRemaining) });

  function recalcTotal() {
    let total = 0;
    for (const inp of inputs.values()) total += Number(inp.value || 0);
    totalEl.textContent = fmtKg(total);
    remEl.textContent = fmtKg(lotRemaining - total);
    remEl.style.color = total > lotRemaining ? '#a8351c' : '';
  }

  const rows = candidates.map((o) => {
    const inp = el('input', {
      type: 'number', step: '0.01', min: '0',
      placeholder: '0',
      class: 'ctrm-input mono w-28 text-right py-1.5',
    });
    const surplusHint = el('span', { class: 'text-[10px] font-mono text-roll ml-1', hidden: 'true' });
    inp.addEventListener('input', () => {
      const v = Number(inp.value || 0);
      const surplus = v - o.remaining_kg;
      if (surplus > 0.001) {
        surplusHint.textContent = `excedente +${fmtKg(surplus)}`;
        surplusHint.removeAttribute('hidden');
      } else {
        surplusHint.setAttribute('hidden', 'true');
      }
      recalcTotal();
    });
    inputs.set(o.id, inp);
    const isFullCovered = o.remaining_kg <= 0.001;
    return el('div', { class: 'flex flex-wrap items-center justify-between gap-2 py-2 border-b border-sand' }, [
      el('div', { class: 'min-w-0' }, [
        el('div', { class: 'flex items-center gap-2 mb-0.5' }, [
          el('span', { class: 'ctrm-code', text: o.order_code }),
          el('span', { class: 'truncate text-[12px] font-display font-semibold text-navy', text: o.reference_name || '' }),
          isFullCovered ? el('span', { class: 'ctrm-pill ok text-[10px]', text: 'Cubierto' }) : null,
        ]),
        el('div', { class: 'text-[11px] text-ink-500 font-mono' }, [
          `Aceptado ${fmtKg(o.kg_green_accepted)} · Asignado ${fmtKg(o.allocated_kg)} · `,
          el('strong', { class: 'text-ink-700' }, [
            isFullCovered ? 'Solo excedente' : `Disponible ${fmtKg(o.remaining_kg)}`,
          ]),
          ` · Entrega ${fmtDate(o.max_delivery_date)}`,
        ]),
      ]),
      el('div', { class: 'flex items-center gap-1' }, [
        inp,
        surplusHint,
        el('button', {
          type: 'button',
          class: 'ctrm-btn ctrm-btn-soft ctrm-btn-xs',
          onClick: () => { inp.value = String(Math.min(o.remaining_kg, lotRemaining - sumExcept(inputs, o.id))); inp.dispatchEvent(new Event('input')); },
        }, ['Llenar']),
      ]),
    ]);
  });

  return el('div', { class: 'space-y-3' }, [
    el('div', { class: 'rounded-lg bg-cream border border-sand p-3 text-[12px] flex flex-wrap items-center gap-x-4 gap-y-1 font-mono' }, [
      el('span', {}, [
        el('span', { class: 'text-ink-500 uppercase tracking-loose text-[10px] mr-1', text: 'Disponible lote' }),
        el('strong', { class: 'text-navy', text: fmtKg(lotRemaining) }),
      ]),
      el('span', {}, [
        el('span', { class: 'text-ink-500 uppercase tracking-loose text-[10px] mr-1', text: 'Asignado' }),
        totalEl,
      ]),
      el('span', {}, [
        el('span', { class: 'text-ink-500 uppercase tracking-loose text-[10px] mr-1', text: 'Restante' }),
        remEl,
      ]),
    ]),
    el('div', { class: 'max-h-[50vh] overflow-y-auto pr-1' }, rows),
    el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
      el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
      el('button', {
        class: 'ctrm-btn ctrm-btn-primary',
        type: 'button',
        onClick: () => {
          const assignments = [];
          let total = 0;
          let surplusOrders = [];
          for (const o of candidates) {
            const v = Number(inputs.get(o.id).value || 0);
            if (v > 0) {
              if (v > o.remaining_kg + 0.001) {
                surplusOrders.push({
                  code: o.order_code,
                  surplus: Math.round((v - o.remaining_kg) * 100) / 100,
                });
              }
              assignments.push({ demand_order_id: o.id, kg_green_allocated: v });
              total += v;
            }
          }
          if (total > lotRemaining + 0.001) { toast('Excede el disponible del lote', 'warning'); return; }
          if (assignments.length === 0) { toast('Ingresa kg para al menos un pedido', 'warning'); return; }
          if (surplusOrders.length > 0) {
            const msg = surplusOrders
              .map((x) => `${x.code} +${fmtKg(x.surplus)}`).join(' · ');
            toast(`Excedente registrado: ${msg}`, 'info', 4500);
          }
          close({ assignments });
        },
      }, ['Guardar asignaciones']),
    ]),
  ]);
}

function sumExcept(inputs, exceptId) {
  let s = 0;
  for (const [id, inp] of inputs) if (id !== exceptId) s += Number(inp.value || 0);
  return s;
}
