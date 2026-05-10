// Finca production module — CTRM-styled.
import { el, clear } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { openModal, confirmModal } from '../ui/modal.js';
import { createCombobox, createMultiCombobox } from '../ui/combobox.js';
import { fmtKg, fmtDate, statusLabel } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';

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

// New flow skips Resting (Drying → Ready). Legacy lots already in
// Resting can still advance to Ready via the same map.
const NEXT_STATUS = {
  InFermentation: 'Drying',
  Drying:         'Ready',
  Resting:        'Ready',  // legacy
  Ready:          'Delivered',
};

export async function fincaLotsView() {
  const refsResP = api.references();
  const varsResP = api.varieties();
  const lotsResP = api.lotsList({ active_only: 'true' });

  const [refsRes, varsRes, lotsRes] = await Promise.all([refsResP, varsResP, lotsResP]);
  let lots = lotsRes.lots;
  const refs = refsRes.references;
  const allVarieties = varsRes.varieties;

  const list = el('div', { class: 'space-y-3' });

  function render() {
    clear(list);
    if (lots.length === 0) {
      list.append(el('p', { class: 'text-[12px] text-ink-300 italic px-1', text: 'Sin lotes activos. Crea uno con el botón de arriba.' }));
      return;
    }
    for (const l of lots) list.append(lotCard(l));
  }
  render();

  return chrome(el('div', {}, [
    pageTitle('Producción', 'Lotes activos en El Vergel'),
    el('div', { class: 'mb-4 flex justify-end gap-2' }, [
      el('button', {
        class: 'ctrm-btn ctrm-btn-yellow uppercase tracking-eyebrow text-[11px] py-2.5 px-5',
        onClick: () => createLot(),
      }, ['+ Crear lote']),
    ]),
    list,
  ]));

  // ---------- Lot card ----------
  function lotCard(l) {
    const next = NEXT_STATUS[l.status];
    const totalAllocated = (l.assignments || []).reduce((s, a) => s + Number(a.kg_green_allocated || 0), 0);
    const remaining = Number(l.kg_green_actual ?? l.kg_green_expected) - totalAllocated;
    const stageLabel = stageLabelOf(l);

    return el('div', { class: 'ctrm-card ctrm-card-pad' }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-2' }, [
        el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
          el('span', { class: 'ctrm-code', text: l.lot_code }),
          el('span', { class: 'font-display font-semibold text-navy text-[13px]', text: l.reference_name || '—' }),
          el('span', { class: 'ctrm-pill roll', text: statusLabel(l.status) }),
          stageLabel ? el('span', { class: 'ctrm-pill muted', text: stageLabel }) : null,
        ]),
        el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
          next ? el('button', {
            class: 'ctrm-btn ctrm-btn-primary ctrm-btn-sm',
            onClick: () => advanceStatus(l, next),
          }, [`→ ${statusLabel(next)}`]) : null,
          el('button', {
            class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
            onClick: () => assignLot(l),
          }, ['Asignar pedidos']),
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
      (l.varieties || []).length > 0
        ? el('div', { class: 'flex flex-wrap gap-1 mt-2' }, (l.varieties || []).map((v) =>
            el('span', { class: 'ctrm-pill dark', text: v.name }),
          ))
        : null,
      (l.assignments || []).length > 0
        ? el('div', { class: 'mt-3 border-t border-sand pt-2' }, [
            el('p', { class: 'eyebrow mb-1.5', text: 'Asignaciones' }),
            el('div', { class: 'space-y-1' }, l.assignments.map((a) =>
              el('div', { class: 'flex flex-wrap items-center justify-between text-[11px] gap-2 py-1' }, [
                el('div', { class: 'flex items-center gap-2 min-w-0' }, [
                  el('span', { class: 'ctrm-code', text: a.order?.order_code || a.demand_order_id }),
                  el('span', { class: 'text-ink-500', text: a.order?.status ? statusLabel(a.order.status) : '' }),
                ]),
                el('div', { class: 'flex items-center gap-3' }, [
                  el('span', { class: 'font-mono text-ink-700 font-medium' }, [fmtKg(a.kg_green_allocated)]),
                  el('button', {
                    class: 'text-crit hover:underline text-[11px]',
                    onClick: () => removeAssignment(a, l),
                  }, ['Quitar']),
                ]),
              ]),
            )),
          ])
        : null,
    ]);
  }

  async function advanceStatus(lot, target) {
    let yieldValues = null;
    if (target === 'Ready' || target === 'Delivered') {
      yieldValues = await promptYield(lot, target);
      if (yieldValues === undefined) return;
    } else {
      const ok = await confirmModal(`Avanzar ${lot.lot_code} a "${statusLabel(target)}"?`, { title: 'Cambio de estado' });
      if (!ok) return;
    }
    try {
      const payload = { lot_id: lot.id, status: target };
      if (yieldValues) {
        if (yieldValues.kg_dried_output    != null) payload.kg_dried_output    = yieldValues.kg_dried_output;
        if (yieldValues.factor_rendimiento != null) payload.factor_rendimiento = yieldValues.factor_rendimiento;
        if (yieldValues.kg_green_actual    != null) payload.kg_green_actual    = yieldValues.kg_green_actual;
      }
      const r = await api.lotUpdateStatus(payload);
      toast(`${lot.lot_code} → ${statusLabel(target)}`, 'success');
      if (r.completions && r.completions.length > 0) {
        toast(`${r.completions.length} pedido(s) completado(s)`, 'success', 4500);
      }
      await reloadLots();
    } catch (e) { toast(e.message, 'error'); }
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
          greenInput.value = (Math.round((seco / fac) * KG_PER_SACO * 100) / 100).toString();
        } else {
          greenInput.value = '';
        }
      };
      driedInput.addEventListener('input', recompute);
      factorInput.addEventListener('input', recompute);
      greenInput.addEventListener('input', () => { greenManuallyEdited = greenInput.value !== ''; });

      return el('div', { class: 'space-y-3' }, [
        el('p', { class: 'text-[12px] text-ink-700 leading-relaxed' }, [
          `Avanzando ${lot.lot_code} a `, el('strong', { class: 'text-navy', text: statusLabel(target) }),
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
      toast('Asignación eliminada', 'success');
      await reloadLots();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function reloadLots() {
    const r = await api.lotsList({ active_only: 'true' });
    lots = r.lots;
    render();
  }

  // ---------- Create lot (stage selector + optional pre-assignment) ----------
  function createLot() {
    return openModal(({ close }) => {
      let chosenRef = null;
      let chosenStage = 'cereza';
      let candidateOrders = [];      // lazy-loaded when reference + process settle
      const assignmentInputs = new Map();   // order_id → input element

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
      });

      const procSelect = el('select', { class: 'ctrm-select' }, [
        el('option', { value: '', disabled: true, selected: true }, ['Selecciona proceso...']),
        ...PROCESS_TYPES.map((p) => el('option', { value: p }, [p])),
      ]);
      procSelect.addEventListener('change', () => maybeRefreshCandidates());

      // Stage selector — visual segmented control
      const stageButtons = STAGE_OPTIONS.map((opt) => el('button', {
        type: 'button',
        class: `ctrm-btn flex-1 uppercase tracking-eyebrow text-[10px] ${opt.value === chosenStage ? 'ctrm-btn-primary' : 'ctrm-btn-soft'}`,
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
      });

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
          const r = await api.ordersList({
            status: 'Accepted,PartiallyAccepted,InProduction',
            reference_id: chosenRef.id,
            process_type: procSelect.value,
          });
          // Compute remaining kg per order based on currently visible lots' assignments.
          const allocByOrder = new Map();
          for (const ll of lots) {
            for (const a of ll.assignments || []) {
              allocByOrder.set(a.demand_order_id, (allocByOrder.get(a.demand_order_id) || 0) + Number(a.kg_green_allocated || 0));
            }
          }
          candidateOrders = (r.orders || []).map((o) => {
            const allocated = allocByOrder.get(o.id) || 0;
            const remaining = Math.max(0, Number(o.kg_green_accepted || 0) - allocated);
            return { ...o, allocated_kg: allocated, remaining_kg: remaining };
          }).filter((o) => o.remaining_kg > 0.001);
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
        labelled('Referencia', refCombo.el),
        labelled('Proceso', procSelect),

        // Stage selector
        el('div', {}, [
          el('label', { class: 'ctrm-label', text: 'Etapa de procesamiento' }),
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

              try {
                const r = await api.lotCreate({
                  reference_id: chosenRef.id,
                  process_type: procSelect.value,
                  processing_stage: chosenStage,
                  kg_input_amount: kg,
                  start_date: startInput.value,
                  fermentation_hours: fermInput.value === '' ? null : Number(fermInput.value),
                  variety_ids: vCombo.getValues().map((v) => v.id),
                  notes: notesInput.value || null,
                  initial_assignments,
                });
                const assignedCount = (r.assignments || []).length;
                toast(`Lote ${r.lot.lot_code} creado${assignedCount ? ` · ${assignedCount} pedido(s) asignado(s)` : ''}`, 'success');
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
      const r = await api.ordersList({
        status: 'Accepted,PartiallyAccepted,InProduction',
        reference_id: lot.reference_id,
        process_type: lot.process_type,
      });
      const allLots = lots;
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
      }).filter((o) => o.remaining_kg > 0.001);
    } catch (e) { toast(e.message, 'error'); return; }

    if (candidates.length === 0) {
      toast('No hay pedidos compatibles con kg disponibles para este lote.', 'warning', 4500);
      return;
    }

    const result = await openModal(({ close }) => assignModalBody(lot, candidates, close), {
      title: `Asignar lote ${lot.lot_code}`, wide: true,
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
      type: 'number', step: '0.01', min: '0', max: String(o.remaining_kg),
      placeholder: '0',
      class: 'ctrm-input mono w-28 text-right py-1.5',
    });
    inp.addEventListener('input', () => recalcTotal());
    inputs.set(o.id, inp);
    return el('div', { class: 'flex flex-wrap items-center justify-between gap-2 py-2 border-b border-sand' }, [
      el('div', { class: 'min-w-0' }, [
        el('div', { class: 'flex items-center gap-2 mb-0.5' }, [
          el('span', { class: 'ctrm-code', text: o.order_code }),
          el('span', { class: 'truncate text-[12px] font-display font-semibold text-navy', text: o.reference_name || '' }),
        ]),
        el('div', { class: 'text-[11px] text-ink-500 font-mono' }, [
          `Aceptado ${fmtKg(o.kg_green_accepted)} · Asignado ${fmtKg(o.allocated_kg)} · `,
          el('strong', { class: 'text-ink-700' }, [`Disponible ${fmtKg(o.remaining_kg)}`]),
          ` · Entrega ${fmtDate(o.max_delivery_date)}`,
        ]),
      ]),
      el('div', { class: 'flex items-center gap-1' }, [
        inp,
        el('button', {
          type: 'button',
          class: 'ctrm-btn ctrm-btn-soft ctrm-btn-xs',
          onClick: () => { inp.value = String(Math.min(o.remaining_kg, lotRemaining - sumExcept(inputs, o.id))); recalcTotal(); },
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
          for (const o of candidates) {
            const v = Number(inputs.get(o.id).value || 0);
            if (v > 0) {
              if (v > o.remaining_kg + 0.001) { toast(`Excede disponible para ${o.order_code}`, 'warning'); return; }
              assignments.push({ demand_order_id: o.id, kg_green_allocated: v });
              total += v;
            }
          }
          if (total > lotRemaining + 0.001) { toast('Excede el disponible del lote', 'warning'); return; }
          if (assignments.length === 0) { toast('Ingresa kg para al menos un pedido', 'warning'); return; }
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
