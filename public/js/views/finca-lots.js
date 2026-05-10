// Finca production module — CTRM-styled.
import { el, clear } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { openModal, confirmModal } from '../ui/modal.js';
import { createCombobox, createMultiCombobox } from '../ui/combobox.js';
import { fmtKg, fmtDate, statusLabel } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';

const PROCESS_TYPES = ['Natural', 'Honey', 'Lavado'];
const CHERRY_PER_GREEN = 7.65;

// Dried→green divisors. Mirror process_lead_times.dried_to_green_divisor in DB.
const DRIED_TO_GREEN_DIVISORS = { Natural: 3.40, Honey: 1.50, Lavado: 1.34 };
const DRIED_LABELS = {
  Natural: 'Cereza seca',
  Honey:   'Pergamino seco (honey)',
  Lavado:  'Pergamino seco (lavado)',
};

const NEXT_STATUS = {
  InFermentation: 'Drying',
  Drying:         'Resting',
  Resting:        'Ready',
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

    return el('div', { class: 'ctrm-card ctrm-card-pad' }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-2' }, [
        el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
          el('span', { class: 'ctrm-code', text: l.lot_code }),
          el('span', { class: 'font-display font-semibold text-navy text-[13px]', text: l.reference_name || '—' }),
          el('span', { class: 'ctrm-pill roll', text: statusLabel(l.status) }),
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
        meta('Cereza fresca', fmtKg(l.kg_cherry_input)),
        meta('Verde esperado', fmtKg(l.kg_green_expected)),
        l.kg_dried_output != null ? meta(DRIED_LABELS[l.process_type] || 'Peso seco', fmtKg(l.kg_dried_output)) : null,
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
        if (yieldValues.kg_dried_output != null) payload.kg_dried_output = yieldValues.kg_dried_output;
        if (yieldValues.kg_green_actual != null) payload.kg_green_actual = yieldValues.kg_green_actual;
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
    const divisor = DRIED_TO_GREEN_DIVISORS[lot.process_type] || 1;
    const driedLabel = DRIED_LABELS[lot.process_type] || 'Peso seco';

    return openModal(({ close }) => {
      const driedInput = el('input', {
        type: 'number', step: '0.01', min: '0',
        value: lot.kg_dried_output != null ? String(lot.kg_dried_output) : '',
        placeholder: 'Ej: 350',
        class: 'ctrm-input mono',
      });
      const greenInput = el('input', {
        type: 'number', step: '0.01', min: '0',
        value: lot.kg_green_actual != null ? String(lot.kg_green_actual) : '',
        placeholder: 'Auto desde peso seco',
        class: 'ctrm-input mono',
      });
      const formula = el('p', { class: 'ctrm-hint' }, [
        `Conversión: ${driedLabel} ÷ ${divisor.toFixed(2)} = kg verde`,
      ]);
      let greenManuallyEdited = lot.kg_green_actual != null;
      const recompute = () => {
        if (greenManuallyEdited) return;
        const v = Number(driedInput.value || 0);
        greenInput.value = v > 0 ? (Math.round((v / divisor) * 100) / 100).toString() : '';
      };
      driedInput.addEventListener('input', recompute);
      greenInput.addEventListener('input', () => { greenManuallyEdited = greenInput.value !== ''; });

      return el('div', { class: 'space-y-3' }, [
        el('p', { class: 'text-[12px] text-ink-700 leading-relaxed' }, [
          `Avanzando ${lot.lot_code} a `, el('strong', { class: 'text-navy', text: statusLabel(target) }),
          '. Registra peso seco y verde real (verde se calcula automáticamente).',
        ]),
        el('label', { class: 'ctrm-label', text: `${driedLabel} (kg)` }),
        driedInput,
        formula,
        el('label', { class: 'ctrm-label mt-2', text: 'kg verde reales' }),
        greenInput,
        el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
          el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(undefined) }, ['Cancelar']),
          el('button', {
            class: 'ctrm-btn ctrm-btn-primary',
            type: 'button',
            onClick: () => {
              const dried = driedInput.value === '' ? null : Number(driedInput.value);
              const green = greenInput.value === '' ? null : Number(greenInput.value);
              if (dried != null && !(dried >= 0)) { toast('Peso seco inválido', 'warning'); return; }
              if (green != null && !(green >= 0)) { toast('kg verde inválido', 'warning'); return; }
              close({ kg_dried_output: dried, kg_green_actual: green });
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

  // ---------- Create lot ----------
  function createLot() {
    return openModal(({ close }) => {
      let chosenRef = null;
      const refCombo = createCombobox({
        placeholder: 'Buscar referencia...',
        items: refs,
        onChange: (item) => {
          chosenRef = item;
          if (item && Array.isArray(item.varieties) && vCombo.getValues().length === 0) {
            vCombo.setValues(item.varieties);
          }
        },
      });

      const procSelect = el('select', { class: 'ctrm-select' }, [
        el('option', { value: '', disabled: true, selected: true }, ['Selecciona proceso...']),
        ...PROCESS_TYPES.map((p) => el('option', { value: p }, [p])),
      ]);

      const kgCherry = el('input', {
        type: 'number', min: '0', step: '0.01',
        class: 'ctrm-input mono',
      });
      const kgGreenHint = el('p', { class: 'ctrm-hint', text: 'Verde esperado: —' });
      kgCherry.addEventListener('input', () => {
        const v = Number(kgCherry.value || 0);
        kgGreenHint.textContent = `Verde esperado: ${fmtKg(v / CHERRY_PER_GREEN)}`;
      });

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

      return el('div', { class: 'space-y-3' }, [
        labelled('Referencia', refCombo.el),
        labelled('Proceso', procSelect),
        labelled('kg cereza ingresados', el('div', {}, [kgCherry, kgGreenHint])),
        labelled('Fecha de inicio', startInput),
        labelled('Horas de fermentación', fermInput),
        labelled('Variedades', vCombo.el),
        labelled('Notas', notesInput),
        el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
          el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
          el('button', {
            class: 'ctrm-btn ctrm-btn-primary',
            type: 'button',
            onClick: async () => {
              if (!chosenRef) { toast('Selecciona referencia', 'warning'); return; }
              if (!procSelect.value) { toast('Selecciona proceso', 'warning'); return; }
              const kg = Number(kgCherry.value);
              if (!(kg > 0)) { toast('kg cereza inválido', 'warning'); return; }
              if (!startInput.value) { toast('Falta fecha de inicio', 'warning'); return; }
              try {
                const r = await api.lotCreate({
                  reference_id: chosenRef.id,
                  process_type: procSelect.value,
                  kg_cherry_input: kg,
                  start_date: startInput.value,
                  fermentation_hours: fermInput.value === '' ? null : Number(fermInput.value),
                  variety_ids: vCombo.getValues().map((v) => v.id),
                  notes: notesInput.value || null,
                });
                toast(`Lote ${r.lot.lot_code} creado`, 'success');
                close({ ok: true });
                await reloadLots();
              } catch (e) { toast(e.message, 'error'); }
            },
          }, ['Crear lote']),
        ]),
      ]);
    }, { title: 'Nuevo lote', wide: true });
  }

  // ---------- Assign lot to orders ----------
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
