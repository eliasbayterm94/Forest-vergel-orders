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
import { actionMenu } from '../ui/action-menu.js';
import { withBusy } from '../ui/busy.js';
import {
  NEXT_TRANSITIONS, INPUT_STAGE_DIVISORS, KG_PER_SACO,
  advanceStatus as advanceStatusShared,
  editBacheModal,
} from './_bache-actions.js';

const LOT_STATUSES = ['InFermentation', 'Drying', 'Resting'];
const LOT_STATUS_LABELS = {
  InFermentation: 'En fermentación',
  Drying: 'Secado',
  Resting: 'Reposo',
  Ready: 'Listo',
};

const PROCESS_TYPES = ['Natural', 'Honey', 'Lavado'];

const STAGE_OPTIONS = [
  { value: 'cereza',     label: 'Cereza fresca',  inputLabel: 'kg de cereza fresca' },
  { value: 'despulpado', label: 'Despulpado',     inputLabel: 'kg de café despulpado' },
  { value: 'seco',       label: 'Seco',           inputLabel: 'kg de café seco' },
];

// Generic dried label (factor is per-lot, not per-process anymore).
const DRIED_LABEL_GENERIC = 'Peso seco';
const DRIED_LABELS_LEGACY = {
  Natural: 'Cereza seca',
  Honey:   'Pergamino seco (honey)',
  Lavado:  'Pergamino seco (lavado)',
};

// Compat alias para código viejo que se refería a NEXT_STATUS[stage].
const NEXT_STATUS = {
  InFermentation: 'Drying',
  Drying:         'Resting',
  Resting:        'Ready',
  // Ready: no direct next — use Despachos.
};

export async function fincaLotsView() {
  // Por defecto ocultamos los baches ya despachados (Delivered) para no
  // saturar la vista. El operador puede activarlos con el toggle
  // "Incluir despachados" cuando necesite p.ej. asignar un pedido a un
  // lote que ya salió (asignación retroactiva).
  let includeDelivered = false;

  const refsResP = api.references();
  const varsResP = api.varieties();
  const lotsResP = api.lotsList({ active_only: 'true' });
  const infResP  = api.infusions().catch(() => ({ infusions: [] }));
  const tanksResP = api.fermentationTanksList({}).catch(() => ({ fermentation_tanks: [] }));
  const ftypesResP = api.fermentationTypesList({}).catch(() => ({ fermentation_types: [] }));

  const [refsRes, varsRes, lotsRes, infRes, tanksRes, ftypesRes] = await Promise.all([refsResP, varsResP, lotsResP, infResP, tanksResP, ftypesResP]);
  let lots = lotsRes.lots.filter((l) => l.status !== 'Ready');
  const refs = refsRes.references;
  const allVarieties = varsRes.varieties;
  const allTanks = (tanksRes && tanksRes.fermentation_tanks) || [];
  const allFermTypes = (ftypesRes && ftypesRes.fermentation_types) || [];
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
        { label: 'Bache',      sortGetter: (l) => l.bache_code || l.lot_code || '',
          total: (arr) => `${arr.length} ${arr.length === 1 ? 'lote' : 'lotes'}` },
        { label: 'Referencia', sortGetter: (l) => l.reference_name || '' },
        { label: 'Variedades', sortGetter: (l) => (l.varieties || []).map((v) => v.name).join(', ') },
        { label: 'Status',     sortGetter: (l) => LOT_STATUSES.indexOf(l.status) },
        { label: 'Proceso',    sortGetter: (l) => l.process_type || '' },
        { label: 'Infusión',   sortGetter: (l) => l.infusion_name || '' },
        { label: 'Inicio',     sortGetter: (l) => l.start_date },
        { label: 'Secado',     sortGetter: (l) => l.drying_start_date },
        { label: 'Descanso',   sortGetter: (l) => l.resting_start_date },
        { label: 'Cereza',     cls: 'text-right', sortGetter: (l) => Number(l.kg_cherry_input || 0),
          total: (arr) => fmtKg(arr.reduce((s, l) => s + Number(l.kg_cherry_input || 0), 0)) },
        { label: 'Verde esp.', cls: 'text-right', sortGetter: (l) => Number(l.kg_green_expected || 0),
          total: (arr) => fmtKg(arr.reduce((s, l) => s + Number(l.kg_green_expected || 0), 0)) },
        { label: 'Verde real', cls: 'text-right', sortGetter: (l) => l.kg_green_actual != null ? Number(l.kg_green_actual) : null,
          total: (arr) => fmtKg(arr.reduce((s, l) => s + Number(l.kg_green_actual || 0), 0)) },
        { label: 'Asignado',   cls: 'text-right', sortGetter: (l) => (l.assignments || []).reduce((s, a) => s + Number(a.kg_green_allocated || 0), 0),
          total: (arr) => fmtKg(arr.reduce((s, l) => s + (l.assignments || []).reduce((ss, a) => ss + Number(a.kg_green_allocated || 0), 0), 0)) },
        { label: 'Parciales',  cls: 'text-right', sortGetter: (l) => (l.partials || []).length,
          total: (arr) => String(arr.reduce((s, l) => s + (l.partials || []).length, 0)) },
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
        const fields = [l.bache_code, l.lot_code, l.reference_name];
        for (const v of (l.varieties || [])) fields.push(v.name);
        return fields.some((s) => (s || '').toLowerCase().includes(lo));
      },
      filters: [
        { key: 'status',          label: 'Estado',
          options: includeDelivered ? [...LOT_STATUSES, 'Delivered'] : LOT_STATUSES,
          optionLabels: { ...LOT_STATUS_LABELS, Delivered: 'Despachado' },
          getter: (l) => l.status },
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

  const headerActions = el('div', { class: 'mb-4 flex justify-end gap-2 flex-wrap' });
  function renderHeaderActions() {
    clear(headerActions);
    headerActions.append(
      el('button', {
        class: `ctrm-btn ctrm-btn-soft uppercase tracking-eyebrow text-[11px] py-2.5 px-5 ${includeDelivered ? 'is-active' : ''}`,
        type: 'button',
        title: includeDelivered
          ? 'Ocultar lotes ya despachados'
          : 'Mostrar también lotes despachados (útil para asignar pedidos retroactivamente)',
        onClick: async () => {
          includeDelivered = !includeDelivered;
          renderHeaderActions();
          await reloadLots();
        },
      }, [includeDelivered ? '✓ Despachados visibles' : 'Incluir despachados']),
      el('button', {
        class: 'ctrm-btn ctrm-btn-soft uppercase tracking-eyebrow text-[11px] py-2.5 px-5',
        title: 'Crea varios baches a la vez en una tabla',
        onClick: () => navigate('/finca/lots-bulk'),
      }, ['+ Crear varios']),
      el('button', {
        class: 'ctrm-btn ctrm-btn-yellow uppercase tracking-eyebrow text-[11px] py-2.5 px-5',
        onClick: () => createLot(),
      }, ['+ Crear lote']),
    );
  }
  renderHeaderActions();

  return chrome(el('div', {}, [
    pageTitle('Producción', 'Lotes activos en El Vergel'),
    headerActions,
    list,
  ]));

  // ---------- Lot table row (table-mode renderer) ----------
  function lotTableRow(l) {
    const totalAllocated = (l.assignments || []).reduce((s, a) => s + Number(a.kg_green_allocated || 0), 0);
    const cap = Number(l.kg_green_actual ?? l.kg_green_expected ?? 0);
    const overflow = totalAllocated - cap;
    const partials = l.partials || [];
    const code = l.bache_code || l.lot_code;
    const transitions = NEXT_TRANSITIONS[l.status] || { primary: null, secondary: [] };
    const primary = transitions.primary;
    let primaryLabel = primary ? primary.label : null;
    if (primary && primary.target === 'Ready' && partials.length > 0) primaryLabel = 'Cerrar';

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

    const secondaryItems = (transitions.secondary || []).map((t) => ({
      label: t.label,
      onClick: () => advanceStatus(l, t.target),
    }));
    const actionsCell = el('div', { class: 'inline-flex gap-1 flex-wrap justify-end items-center' }, [
      primary ? actionBtn(primaryLabel, 'primary', () => advanceStatus(l, primary.target)) : null,
      actionMenu([
        ...secondaryItems,
        { label: 'Despachar',     hidden: l.status !== 'Ready',
          onClick: () => { location.hash = '/finca/despachos'; } },
        { label: 'Asignar pedidos', onClick: () => assignLot(l) },
        { label: 'Editar bache',    onClick: () => editBacheCode(l) },
        { label: 'Eliminar bache',  danger: true, onClick: () => deleteLot(l) },
      ]),
    ]);

    const varieties = l.varieties || [];
    const varietiesCell = varieties.length === 0
      ? document.createTextNode('—')
      : el('div', { class: 'flex flex-wrap gap-1' }, varieties.map((v) =>
          el('span', { class: 'ctrm-pill dark text-[10px]', text: v.name })));

    const restingCell = l.resting_start_date || (l.resting_cycles_count || 0) > 0
      ? el('div', { class: 'flex flex-col gap-0.5 items-start' }, [
          l.resting_start_date
            ? el('span', { class: 'font-mono text-[11px]', text: fmtDate(l.resting_start_date) })
            : null,
          l.resting_humidity != null
            ? el('span', { class: `ctrm-pill text-[10px] ${humidityPillKind(l.resting_humidity)}`,
                text: `${l.resting_humidity}%` })
            : null,
          (l.resting_cycles_count || 0) > 1
            ? el('span', { class: 'ctrm-pill text-[10px]',
                style: 'background:#1a3a5c;color:#fff;',
                title: `${l.resting_cycles_count} ciclos`,
                text: `× ${l.resting_cycles_count}` })
            : null,
        ])
      : document.createTextNode('—');

    return el('tr', {
      class: 'hover:bg-cream',
    }, [
      tcell('Bache', 'font-mono text-navy font-semibold cursor-pointer hover:underline',
        el('span', {
          title: 'Ver detalle del bache',
          onClick: () => navigate(`/finca/bache?id=${l.id}`),
        }, [code])),
      tcell('Referencia', l.reference_name ? '' : 'italic text-ink-300',
        l.reference_name || 'Sin referencia'),
      tcell('Variedades', '', varietiesCell),
      tcell('Status', '', el('div', { class: 'flex flex-wrap items-center gap-1' }, [
        el('span', { class: `ctrm-pill ${statusPillKind(l.status)}`, text: statusLabel(l.status) }),
        ...(l.status === 'Drying'
          ? (l.drying_locations || []).map((loc) =>
              el('span', { class: 'ctrm-pill text-[10px]',
                style: 'background:#dde7ee;color:#1a3a5c;', text: loc }))
          : []),
      ])),
      tcell('Proceso', 'text-[11px]', l.process_type),
      tcell('Infusión', 'text-[11px]', l.infusion_name
        ? `${l.infusion_name} ${l.infusion_pct}%`
        : '—'),
      tcell('Inicio', 'font-mono text-[11px]', fmtDate(l.start_date)),
      tcell('Secado', 'font-mono text-[11px]', fmtDate(l.drying_start_date)),
      tcell('Descanso', '', restingCell),
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
    const transitions = NEXT_TRANSITIONS[l.status] || { primary: null, secondary: [] };
    const primaryTransition = transitions.primary;
    const totalAllocated = (l.assignments || []).reduce((s, a) => s + Number(a.kg_green_allocated || 0), 0);
    const capacity  = Number(l.kg_green_actual ?? l.kg_green_expected ?? 0);
    const remaining = capacity - totalAllocated;
    const overflow  = totalAllocated - capacity;       // positive when over-allocated
    const isOverAllocated = overflow > 0.01;
    const stageLabel = stageLabelOf(l);
    const partials = l.partials || [];
    const isDrying = l.status === 'Drying';
    const primaryLabel = !primaryTransition
      ? null
      : (primaryTransition.target === 'Ready' && partials.length > 0 ? 'Cerrar bache' : primaryTransition.label);

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
          l.parent_lot_id
            ? el('span', { class: 'ctrm-pill text-[9px] mr-0.5', style: 'background:#e0e7f5;color:#1b2044;', text: 'SUB' })
            : null,
          el('span', {
            class: 'ctrm-code cursor-pointer hover:underline',
            title: 'Ver detalle del bache',
            onClick: () => navigate(`/finca/bache?id=${l.id}`),
            text: l.bache_code || l.lot_code,
          }),
          (l.bache_code && l.bache_code !== l.lot_code)
            ? el('span', { class: 'text-[10px] text-ink-300 font-mono', text: l.lot_code })
            : null,
          l.reference_name
            ? el('span', { class: 'font-display font-semibold text-navy text-[13px]', text: l.reference_name })
            : el('span', { class: 'font-display italic text-ink-300 text-[13px]', text: 'Sin referencia' }),
          el('span', { class: `ctrm-pill ${statusPillKind(l.status)}`, text: statusLabel(l.status) }),
          stageLabel ? el('span', { class: 'ctrm-pill muted', text: stageLabel }) : null,
          infusionPill(l),
          ...((l.varieties || []).map((v) =>
            el('span', { class: 'ctrm-pill dark text-[10px]', text: v.name }))),
          ...(l.status === 'Drying'
            ? (l.drying_locations || []).map((loc) =>
                el('span', { class: 'ctrm-pill', style: 'background:#dde7ee;color:#1a3a5c;', text: loc }))
            : []),
          l.status === 'Resting' && l.resting_humidity != null
            ? el('span', { class: `ctrm-pill ${humidityPillKind(l.resting_humidity)}`,
                text: `Humedad ${l.resting_humidity}%` })
            : null,
          (l.resting_cycles_count || 0) > 1
            ? el('span', { class: 'ctrm-pill', style: 'background:#1a3a5c;color:#fff;',
                title: `${l.resting_cycles_count} ciclos de descanso registrados`,
                text: `Descansos: ${l.resting_cycles_count}` })
            : null,
        ]),
        el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
          primaryTransition ? el('button', {
            class: 'ctrm-btn ctrm-btn-primary ctrm-btn-sm',
            onClick: () => advanceStatus(l, primaryTransition.target),
          }, [primaryLabel]) : null,
          // Acciones secundarias (ej. saltar a Listo desde Drying o volver a Secado desde Resting).
          ...(transitions.secondary || []).map((t) =>
            el('button', {
              class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
              onClick: () => advanceStatus(l, t.target),
            }, [t.label])),
          // Dividir sub-bache (disponible en InFermentation, Drying, Resting, Ready)
          ['InFermentation', 'Drying', 'Resting', 'Ready'].includes(l.status)
            ? el('button', {
                class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
                title: 'Dividir en sub-bache (P1, P2...)',
                onClick: () => openSplitModal(l),
              }, ['Dividir'])
            : null,
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
          actionMenu([
            { label: 'Eliminar bache', danger: true, onClick: () => deleteLot(l) },
          ]),
        ]),
      ]),
      el('div', { class: 'flex flex-wrap text-[12px] text-ink-500 gap-x-4 gap-y-1 font-mono' }, [
        l.kg_cherry_input     != null ? meta('Cereza fresca', fmtKg(l.kg_cherry_input)) : null,
        l.kg_despulpado_input != null ? meta('Despulpado',    fmtKg(l.kg_despulpado_input)) : null,
        meta('Verde esperado', fmtKg(l.kg_green_expected)),
        l.kg_dried_output != null ? meta(DRIED_LABEL_GENERIC, fmtKg(l.kg_dried_output)) : null,
        l.factor_rendimiento != null ? meta('Factor', String(l.factor_rendimiento)) : null,
        l.conversion_factor != null ? meta('Conversión', `${l.conversion_factor}×`) : null,
        l.kg_green_actual != null ? meta('Verde real', fmtKg(l.kg_green_actual)) : null,
        meta('Inicio', fmtDate(l.start_date)),
        l.drying_start_date ? meta('Drying', fmtDate(l.drying_start_date)) : null,
        l.resting_start_date ? meta('Descanso', fmtDate(l.resting_start_date)) : null,
        meta('Asignado', fmtKg(totalAllocated)),
        metaColor('Disponible', fmtKg(remaining), remaining < -0.001 ? 'crit' : null),
        meta('Proceso', l.process_type),
      ]),
      // ── Detalle expandible ───────────────────────────────────────
      isExp ? el('div', {}, [
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
    const fullySplit = false;

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
    // Calcular siguiente P disponible
    const usedNums = (lot.partials || [])
      .map((p) => {
        const m = (p.parcial_letter || '').match(/^P(\d+)$/);
        return m ? Number(m[1]) : null;
      })
      .filter((n) => n != null);
    const nextP = usedNums.length > 0 ? Math.max(...usedNums) + 1 : 1;

    return openModal(({ close }) => {
      const pInput = el('input', {
        type: 'number', step: '1', min: '1', max: '99',
        value: String(nextP),
        class: 'ctrm-input mono text-center w-20',
      });
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
        el('div', {}, [
          el('label', { class: 'ctrm-label', text: 'Número de parcial (P___)' }),
          el('div', { class: 'flex items-center gap-1' }, [
            el('span', { class: 'font-mono font-bold text-navy text-[14px]', text: 'P' }),
            pInput,
          ]),
        ]),
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
              const pNum = Number(pInput.value);
              if (!Number.isFinite(pNum) || pNum < 1 || pNum > 99 || pNum !== Math.floor(pNum)) {
                toast('Número P inválido (1-99)', 'warning'); return;
              }
              const d = Number(driedInput.value);
              const f = Number(factorInput.value);
              if (!(d > 0)) { toast('Peso seco inválido', 'warning'); return; }
              if (!(f > 0)) { toast('Factor inválido', 'warning'); return; }
              try {
                await api.lotPartialCreate({
                  production_lot_id: lot.id,
                  parcial_letter: `P${pNum}`,
                  kg_dried: d,
                  factor_rendimiento: f,
                  notes: notesInput.value || null,
                });
                toast(`Parcial P${pNum} registrado`, 'success');
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

  // Wrapper de advanceStatusShared (vive en _bache-actions.js) con la
  // integración de toast + reloadLots de esta vista.
  async function advanceStatus(lot, target) {
    try {
      const r = await advanceStatusShared(lot, target);
      if (r === null) return; // usuario canceló un prompt
      toast(`${lot.bache_code || lot.lot_code} → ${statusLabel(target)}`, 'success');
      if (r && r.completions && r.completions.length > 0) {
        toast(`${r.completions.length} pedido(s) completado(s)`, 'success', 4500);
      }
      await reloadLots();
    } catch (e) {
      console.error('advanceStatus failed', e);
      toast(e.message || 'Error en el cambio de estado', 'error', 6000);
    }
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
    const r = includeDelivered
      ? await api.lotsList({})
      : await api.lotsList({ active_only: 'true' });
    lots = includeDelivered ? r.lots : r.lots.filter((l) => l.status !== 'Ready');
    render();
  }

  // ---------- Dividir sub-bache ----------
  async function openSplitModal(lot) {
    const kgBase = Number(lot.kg_input_initial || 0);
    if (kgBase <= 0) { toast('El bache no tiene kg registrado', 'warning'); return; }

    const result = await openModal(({ close }) => {
      const pInput = el('input', {
        type: 'number', step: '1', min: '1', max: '99',
        class: 'ctrm-input mono text-center w-20',
        placeholder: '1',
      });
      const kgInput = el('input', {
        type: 'number', step: '0.01', min: '0.01', max: String(kgBase - 0.01),
        class: 'ctrm-input mono text-right w-full',
        placeholder: `Máx ${fmtKg(kgBase - 0.01)}`,
      });
      const notesInput = el('input', { type: 'text', class: 'ctrm-input w-full',
        placeholder: 'Notas (opcional)' });

      return el('div', { class: 'space-y-3' }, [
        el('div', { class: 'rounded-lg bg-cream border border-sand p-3' }, [
          el('p', { class: 'text-[12px] text-ink-700' }, [
            `El bache `, el('strong', { class: 'text-navy', text: lot.bache_code || lot.lot_code }),
            ` tiene `, el('strong', { text: fmtKg(kgBase) }), ` kg.`,
          ]),
          el('p', { class: 'text-[11px] text-ink-500 mt-1',
            text: 'Elige el número P y los kg a separar. El sub-bache continuará en el mismo estado.' }),
        ]),
        el('div', { class: 'grid grid-cols-2 gap-3' }, [
          el('div', {}, [
            el('label', { class: 'ctrm-label', text: 'Número (P___)' }),
            el('div', { class: 'flex items-center gap-1' }, [
              el('span', { class: 'font-mono font-bold text-navy text-[14px]', text: 'P' }),
              pInput,
            ]),
          ]),
          el('div', {}, [
            el('label', { class: 'ctrm-label', text: 'kg a separar' }), kgInput,
          ]),
        ]),
        el('div', {}, [
          el('label', { class: 'ctrm-label', text: 'Notas' }), notesInput,
        ]),
        el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
          el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button',
            onClick: () => close(null) }, ['Cancelar']),
          el('button', { class: 'ctrm-btn ctrm-btn-primary', type: 'button',
            onClick: async () => {
              const pNum = Number(pInput.value);
              if (!Number.isFinite(pNum) || pNum < 1 || pNum > 99 || pNum !== Math.floor(pNum)) {
                toast('Indica un número P entre 1 y 99', 'warning'); return;
              }
              const kg = Number(kgInput.value);
              if (!Number.isFinite(kg) || kg <= 0) { toast('Indica kg > 0', 'warning'); return; }
              if (kg >= kgBase) { toast('Debe ser menor al total del padre', 'warning'); return; }
              try {
                const r = await api.lotSplit({
                  production_lot_id: lot.id,
                  sub_number: pNum,
                  kg_to_split: kg,
                  notes: notesInput.value || undefined,
                });
                close({ ok: true, child: r.child });
              } catch (e) { toast(e.message || 'Error al dividir', 'error'); }
            },
          }, ['Dividir']),
        ]),
      ]);
    }, { title: `Dividir ${lot.bache_code || lot.lot_code}` });

    if (result && result.ok) {
      toast(`Sub-bache ${result.child?.bache_code || ''} creado`, 'success');
      reloadLots().catch((err) => toast(`No se pudo refrescar: ${err.message}`, 'error'));
    }
  }

  // ---------- Edit bache ----------
  // Delegamos al modal compartido en _bache-actions.js. Tras guardar,
  // recargamos la lista.
  async function editBacheCode(lot) {
    const r = await editBacheModal(lot);
    if (r && r.ok) {
      reloadLots().catch((err) => toast(`No se pudo refrescar: ${err.message}`, 'error'));
    }
  }

  // ---------- Delete bache ----------
  async function deleteLot(lot) {
    const code = lot.bache_code || lot.lot_code;
    const assignments = (lot.assignments || []).length;
    const partials    = (lot.partials || []).length;

    const detail = [
      assignments > 0
        ? `· Se removerán ${assignments} ${assignments === 1 ? 'asignación a pedido' : 'asignaciones a pedidos'} (los pedidos vuelven a quedar pendientes de lote).`
        : null,
      partials > 0
        ? `· Se borrarán ${partials} ${partials === 1 ? 'parcial registrado' : 'parciales registrados'}.`
        : null,
    ].filter(Boolean).join('\n');

    const ok = await confirmModal(
      `¿Eliminar el bache ${code}?\n\nEsta acción no se puede deshacer.${detail ? '\n\n' + detail : ''}`,
      { title: 'Eliminar bache', confirmText: 'Eliminar', danger: true },
    );
    if (!ok) return;

    const loading = toast('Eliminando…', 'info', 0);
    try {
      const res = await api.lotDelete({ lot_id: lot.id });
      const removed = res?.assignments_removed || 0;
      loading.close();
      toast(
        removed > 0
          ? `Bache ${code} eliminado · ${removed} ${removed === 1 ? 'asignación liberada' : 'asignaciones liberadas'}`
          : `Bache ${code} eliminado`,
        'success',
      );
      await reloadLots();
    } catch (e) {
      loading.close();
      toast(e.message || 'No se pudo eliminar', 'error');
    }
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
        type: 'number', min: '0', step: '0.5', value: '0',
        placeholder: '0 = entra directo a Secado',
        class: 'ctrm-input mono',
      });
      // Sección que aparece cuando fermentation_hours === 0
      // (skip-fermentation → lote nace en Drying directo).
      const dryingStartTimeInput = el('input', {
        type: 'datetime-local',
        class: 'ctrm-input mono text-[12px]',
      });
      const dryingTanksLoaderHint = el('span', { class: 'text-[10px] text-ink-300 italic', text: 'Cargando…' });
      let dryingCombo = null;
      // Cargamos los tipos de secado solo si se va a usar (skip-ferm).
      let dryingTypesLoaded = false;
      const dryingTanksWrap = el('div', { class: 'min-h-[40px]' }, [dryingTanksLoaderHint]);
      const ensureDryingTypesLoaded = async () => {
        if (dryingTypesLoaded) return;
        dryingTypesLoaded = true;
        let types = [];
        try {
          const r = await api.dryingTypesList({});
          types = (r && r.drying_types) || [];
        } catch { types = []; }
        const items = types.map((t) => ({ id: t.id, name: t.name }));
        dryingCombo = createMultiCombobox({
          placeholder: items.length > 0 ? 'Equipo / lugar de secado…' : 'Sin tipos (admin en /admin/config)',
          items,
        });
        dryingTanksWrap.replaceChildren(dryingCombo.el);
      };
      const skipSection = el('div', {
        class: 'p-3 rounded-md border border-warn/40 bg-warn/5 space-y-2',
        style: 'display:none;',
      }, [
        el('p', { class: 'text-[11px] text-warn font-semibold',
          text: '⚠ Como las horas de fermentación son 0, el bache entrará directo a Secado.' }),
        el('div', {}, [
          el('label', { class: 'ctrm-label', text: 'Equipo / lugar de secado *' }),
          dryingTanksWrap,
        ]),
        el('div', {}, [
          el('label', { class: 'ctrm-label', text: 'Hora exacta de inicio de secado (opcional)' }),
          dryingStartTimeInput,
        ]),
      ]);
      fermInput.addEventListener('input', () => {
        const v = Number(fermInput.value);
        if (Number.isFinite(v) && v === 0) {
          skipSection.style.display = '';
          ensureDryingTypesLoaded();
        } else {
          skipSection.style.display = 'none';
        }
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

      // Tanques de fermentación (multi-select, sin onCreate — el
      // admin los gestiona en /admin/config).
      const tanksCombo = createMultiCombobox({
        placeholder: allTanks.length > 0 ? 'Selecciona tanques…' : 'Sin tanques configurados (admin en /admin/config)',
        items: allTanks,
      });

      // Tipos de fermentación (multi-select).
      const fermTypesCombo = createMultiCombobox({
        placeholder: allFermTypes.length > 0 ? 'Tipos de fermentación…' : 'Sin tipos configurados (admin en /admin/config)',
        items: allFermTypes,
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
        if (!procSelect.value) {
          assignWrap.innerHTML = '';
          assignWrap.append(el('p', { class: 'ctrm-hint', text: 'Selecciona proceso para ver pedidos compatibles.' }));
          return;
        }
        if (!chosenRef) {
          assignWrap.innerHTML = '';
          assignWrap.append(el('p', { class: 'ctrm-hint',
            text: 'Sin referencia: este bache se creará como stock disponible. Asignalo a un pedido más adelante desde la tabla.' }));
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
        el('div', {}, [
          el('label', { class: 'ctrm-label', text: 'Referencia (opcional)' }),
          refCombo.el,
          el('p', { class: 'ctrm-hint',
            text: 'Si no la conoces aún, deja en blanco. El bache adoptará la referencia cuando lo asignes al primer pedido.' }),
        ]),
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
        labelled('Horas de fermentación *', fermInput),
        skipSection,
        el('div', {}, [
          el('label', { class: 'ctrm-label' }, [
            'Variedades ',
            el('span', { class: 'ctrm-req', text: '*' }),
          ]),
          vCombo.el,
          el('p', { class: 'ctrm-hint', text: 'Al menos una variedad.' }),
        ]),
        el('div', {}, [
          el('label', { class: 'ctrm-label', text: 'Tanques de fermentación' }),
          tanksCombo.el,
          el('p', { class: 'ctrm-hint', text: 'Selecciona uno o más. Administra los disponibles en /admin/config.' }),
        ]),
        el('div', {}, [
          el('label', { class: 'ctrm-label', text: 'Tipos de fermentación' }),
          fermTypesCombo.el,
          el('p', { class: 'ctrm-hint', text: 'Métodos aplicados durante la fermentación (Aeróbico, Anaeróbico, etc).' }),
        ]),
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
            onClick: async (e) => {
              const btn = e.currentTarget;
              const bacheCode = bacheInput.value.trim();
              if (!bacheCode) { toast('Falta código de bache', 'warning'); return; }
              if (!procSelect.value) { toast('Selecciona proceso', 'warning'); return; }
              const kg = Number(kgInput.value);
              if (!(kg > 0)) { toast(`${stageInputLabelOf(chosenStage)}: valor inválido`, 'warning'); return; }
              if (!startInput.value) { toast('Falta fecha de inicio', 'warning'); return; }
              if (vCombo.getValues().length === 0) {
                toast('Selecciona al menos una variedad', 'warning'); return;
              }

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
                const fermHoursNum = fermInput.value === '' ? 0 : Number(fermInput.value);
                if (!Number.isFinite(fermHoursNum) || fermHoursNum < 0) {
                  toast('Horas de fermentación: indica un número ≥ 0', 'warning'); return;
                }
                // Si skip-fermentation: drying locations es obligatorio.
                const skipFerm = fermHoursNum === 0;
                let dryingLocs = [];
                if (skipFerm) {
                  dryingLocs = dryingCombo ? dryingCombo.getValues().map((d) => d.name) : [];
                  if (dryingLocs.length === 0) {
                    toast('Con 0h de fermentación, selecciona al menos un equipo de secado', 'warning', 4500);
                    return;
                  }
                }
                const localToIso = (v) => v ? new Date(v).toISOString() : null;
                const r = await withBusy(btn, 'Creando lote…', () => api.lotCreate({
                  bache_code: bacheCode,
                  reference_id: chosenRef ? chosenRef.id : null,
                  process_type: procSelect.value,
                  processing_stage: chosenStage,
                  kg_input_amount: kg,
                  start_date: startInput.value,
                  fermentation_hours: fermHoursNum,
                  variety_ids: [...new Set(vCombo.getValues().map((v) => v.id))],
                  fermentation_tanks: tanksCombo.getValues().map((t) => t.name),
                  fermentation_types: fermTypesCombo.getValues().map((t) => t.name),
                  drying_locations: skipFerm ? dryingLocs : undefined,
                  drying_start_at: skipFerm ? (localToIso(dryingStartTimeInput.value) || undefined) : undefined,
                  notes: notesInput.value || null,
                  infusion_id: chosenInfusion ? chosenInfusion.id : null,
                  infusion_pct: chosenInfusion ? infusionPct : null,
                  initial_assignments,
                }));
                const lotInfo = r && r.lot;
                const code = (lotInfo && (lotInfo.bache_code || lotInfo.lot_code)) || bacheCode;
                const assignedCount = ((r && r.assignments) || []).length;
                toast(`Lote ${code} creado${assignedCount ? ` · ${assignedCount} pedido(s) asignado(s)` : ''}`, 'success');
                close({ ok: true });
                // El reload sucede después de cerrar el modal para no
                // bloquear el feedback visual al usuario.
                reloadLots().catch((err) => toast(`No se pudo refrescar: ${err.message}`, 'error'));
              } catch (e) {
                console.error('lotCreate failed', e, e?.detail);
                const detail = e?.detail && typeof e.detail === 'object'
                  ? ` (${e.detail.detail || e.detail.message || e.code || ''})`
                  : '';
                toast(`No se pudo crear el lote: ${e.message || 'error desconocido'}${detail}`, 'error', 8000);
              }
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
      // Si el bache aún no tiene referencia (stock disponible), listamos
      // todos los pedidos compatibles por proceso. Al asignarse al primero,
      // el trigger de BD copia order.reference_id → lot.reference_id y
      // partir de ahí la referencia queda fija.
      const orderQuery = {
        status: 'Accepted,PartiallyAccepted,InProduction,Completed',
        process_type: lot.process_type,
      };
      if (lot.reference_id) orderQuery.reference_id = lot.reference_id;

      const [r, allLotsRes] = await Promise.all([
        api.ordersList(orderQuery),
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

    const loading = toast('Asignando…', 'info', 0);
    try {
      await api.assignmentsCreate({
        production_lot_id: lot.id,
        assignments: assignments.map((a) => ({
          demand_order_id: a.demand_order_id,
          kg_green_allocated: Number(a.kg_green_allocated),
        })),
      });
      loading.close();
      toast('Asignaciones creadas', 'success');
      await reloadLots();
    } catch (e) { loading.close(); toast(e.message, 'error'); }
  }
}

// Reglas de Descanso. Devuelve { maxDays, level: 'green'|'amber'|'red' }.
// humedad > 20%   → máx 5 días
// humedad 14-20%  → máx 8 días
// humedad < 14%   → sin restricción (verde)
export function restingRule(humidity) {
  const h = Number(humidity);
  if (!Number.isFinite(h) || h <= 0) return { maxDays: null, level: 'green' };
  if (h > 20)  return { maxDays: 5, level: 'red'   };
  if (h >= 14) return { maxDays: 8, level: 'amber' };
  return { maxDays: null, level: 'green' };
}

function humidityPillKind(h) {
  const r = restingRule(h);
  if (r.level === 'red')   return 'urgency-red';
  if (r.level === 'amber') return 'urgency-amber';
  return 'ok';
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
    !lot.reference_id ? el('div', {
      class: 'rounded-lg bg-yellow/10 border border-yellow p-3 text-[12px] text-ink-700',
    }, [
      el('strong', { text: 'Sin referencia · ' }),
      'Este bache adoptará la referencia del pedido que le asignes. La elección queda fija después.',
    ]) : null,
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
