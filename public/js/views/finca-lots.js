// Finca production module:
// - List active lots
// - Create lot (modal: reference + process + kg cherry + start date + varieties + ferm hours)
// - Advance status (one step at a time)
// - Assign lot to demand orders with kg allocation (compatible by ref + process)
import { el, clear } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { openModal, confirmModal } from '../ui/modal.js';
import { createCombobox, createMultiCombobox } from '../ui/combobox.js';
import { fmtKg, fmtDate, statusLabel } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';

const PROCESS_TYPES = ['Natural', 'Honey', 'Lavado'];
const CHERRY_PER_GREEN = 7.65;

// Dried→green divisors. Must mirror process_lead_times.dried_to_green_divisor
// in the DB; the server is authoritative — these are UI hints only.
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
      list.append(el('p', { class: 'text-sm text-slate-400 italic px-1', text: 'Sin lotes activos. Crea uno con el botón de arriba.' }));
      return;
    }
    for (const l of lots) list.append(lotCard(l));
  }
  render();

  return chrome(el('div', {}, [
    pageTitle('Producción', 'Lotes activos en El Vergel'),
    el('div', { class: 'mb-3 flex justify-end gap-2' }, [
      el('button', {
        class: 'px-4 py-2 rounded-lg bg-forest hover:bg-forest-dark text-white',
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

    return el('div', { class: 'bg-white rounded-xl border border-slate-200 p-3 sm:p-4' }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mb-1' }, [
        el('div', { class: 'flex items-center gap-2' }, [
          el('span', { class: 'font-mono text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700', text: l.lot_code }),
          el('span', { class: 'font-medium text-slate-900', text: l.reference_name || '—' }),
          el('span', { class: 'text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-800', text: statusLabel(l.status) }),
        ]),
        el('div', { class: 'flex items-center gap-2' }, [
          next ? el('button', {
            class: 'px-3 py-1.5 rounded-lg bg-forest text-white text-sm',
            onClick: () => advanceStatus(l, next),
          }, [`→ ${statusLabel(next)}`]) : null,
          el('button', {
            class: 'px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm',
            onClick: () => assignLot(l),
          }, ['Asignar pedidos']),
        ]),
      ]),
      el('div', { class: 'flex flex-wrap text-xs text-slate-600 gap-x-4 gap-y-1' }, [
        el('span', {}, [`Cereza fresca: `, el('strong', { text: fmtKg(l.kg_cherry_input) })]),
        el('span', {}, [`Verde esperado: `, el('strong', { text: fmtKg(l.kg_green_expected) })]),
        l.kg_dried_output != null ? el('span', {}, [`${DRIED_LABELS[l.process_type] || 'Peso seco'}: `, el('strong', { text: fmtKg(l.kg_dried_output) })]) : null,
        l.kg_green_actual != null ? el('span', {}, [`Verde real: `, el('strong', { text: fmtKg(l.kg_green_actual) })]) : null,
        el('span', {}, [`Inicio: `, el('strong', { text: fmtDate(l.start_date) })]),
        l.drying_start_date ? el('span', {}, [`Drying: `, el('strong', { text: fmtDate(l.drying_start_date) })]) : null,
        el('span', {}, [`Asignado: `, el('strong', { text: fmtKg(totalAllocated) })]),
        el('span', {
          class: remaining < -0.001 ? 'text-rose-700 font-semibold' : '',
        }, [`Disponible: `, el('strong', { text: fmtKg(remaining) })]),
        el('span', {}, [`Proceso: `, el('strong', { text: l.process_type })]),
      ]),
      (l.varieties || []).length > 0
        ? el('div', { class: 'flex flex-wrap gap-1 text-[11px] mt-1' }, (l.varieties || []).map((v) =>
            el('span', { class: 'px-2 py-0.5 rounded-full bg-forest-light/15 text-forest-dark', text: v.name }),
          ))
        : null,
      (l.assignments || []).length > 0
        ? el('div', { class: 'mt-2 border-t border-slate-100 pt-2' }, [
            el('p', { class: 'text-[11px] uppercase text-slate-500 tracking-wide mb-1' }, ['Asignaciones']),
            el('div', { class: 'space-y-1' }, l.assignments.map((a) =>
              el('div', { class: 'flex flex-wrap items-center justify-between text-xs gap-2' }, [
                el('div', { class: 'flex items-center gap-2 min-w-0' }, [
                  el('span', { class: 'font-mono text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700', text: a.order?.order_code || a.demand_order_id }),
                  el('span', { class: 'truncate text-slate-700', text: a.order?.status ? statusLabel(a.order.status) : '' }),
                ]),
                el('div', { class: 'flex items-center gap-2' }, [
                  el('span', { class: 'text-slate-700' }, [fmtKg(a.kg_green_allocated)]),
                  el('button', {
                    class: 'text-rose-700 hover:underline',
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
      if (yieldValues === undefined) return; // cancelled
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
        class: 'w-full px-3 py-2 rounded-lg border border-slate-300',
      });
      const greenInput = el('input', {
        type: 'number', step: '0.01', min: '0',
        value: lot.kg_green_actual != null ? String(lot.kg_green_actual) : '',
        placeholder: 'Auto desde peso seco',
        class: 'w-full px-3 py-2 rounded-lg border border-slate-300',
      });
      const formula = el('p', { class: 'text-xs text-slate-500' }, [
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
        el('p', { class: 'text-sm text-slate-700' }, [
          `Avanzando ${lot.lot_code} a `, el('strong', { text: statusLabel(target) }),
          '. Registra peso seco y verde real (verde se calcula automáticamente).',
        ]),
        el('label', { class: 'block text-sm font-medium text-slate-700', text: `${driedLabel} (kg)` }),
        driedInput,
        formula,
        el('label', { class: 'block text-sm font-medium text-slate-700 mt-2', text: 'kg verde reales' }),
        greenInput,
        el('div', { class: 'flex justify-end gap-2 pt-2' }, [
          el('button', { class: 'px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700', type: 'button', onClick: () => close(undefined) }, ['Cancelar']),
          el('button', {
            class: 'px-4 py-2 rounded-lg bg-forest hover:bg-forest-dark text-white',
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

      const procSelect = el('select', {
        class: 'w-full px-3 py-2 rounded-lg border border-slate-300 bg-white',
      }, [
        el('option', { value: '', disabled: true, selected: true }, ['Selecciona proceso...']),
        ...PROCESS_TYPES.map((p) => el('option', { value: p }, [p])),
      ]);

      const kgCherry = el('input', {
        type: 'number', min: '0', step: '0.01',
        class: 'w-full px-3 py-2 rounded-lg border border-slate-300',
      });
      const kgGreenHint = el('p', { class: 'text-xs text-slate-500 mt-1', text: 'Verde esperado: —' });
      kgCherry.addEventListener('input', () => {
        const v = Number(kgCherry.value || 0);
        kgGreenHint.textContent = `Verde esperado: ${fmtKg(v / CHERRY_PER_GREEN)}`;
      });

      const startInput = el('input', {
        type: 'date', value: new Date().toISOString().slice(0, 10),
        class: 'w-full px-3 py-2 rounded-lg border border-slate-300',
      });

      const fermInput = el('input', {
        type: 'number', min: '0', step: '0.5', placeholder: 'Opcional',
        class: 'w-full px-3 py-2 rounded-lg border border-slate-300',
      });

      const vCombo = createMultiCombobox({
        placeholder: 'Variedades...',
        items: allVarieties,
      });

      const notesInput = el('textarea', {
        rows: '2',
        class: 'w-full px-3 py-2 rounded-lg border border-slate-300',
      });

      return el('div', { class: 'space-y-3' }, [
        labelled('Referencia', refCombo.el),
        labelled('Proceso', procSelect),
        labelled('kg cereza ingresados', el('div', {}, [kgCherry, kgGreenHint])),
        labelled('Fecha de inicio', startInput),
        labelled('Horas de fermentación', fermInput),
        labelled('Variedades', vCombo.el),
        labelled('Notas', notesInput),
        el('div', { class: 'flex justify-end gap-2 pt-2' }, [
          el('button', { class: 'px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700', type: 'button', onClick: () => close(null) }, ['Cancelar']),
          el('button', {
            class: 'px-4 py-2 rounded-lg bg-forest hover:bg-forest-dark text-white',
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
    // Pull compatible candidate orders: same reference, same process, status acceptable.
    let candidates = [];
    try {
      const r = await api.ordersList({
        status: 'Accepted,PartiallyAccepted,InProduction',
        reference_id: lot.reference_id,
        process_type: lot.process_type,
      });
      // Compute already-assigned per order so we know remaining capacity.
      // The API doesn't return this aggregated by order; we compute from
      // production-lots-list (already loaded) for any lot containing the order.
      const allLots = lots; // currently active lots only — close enough for MVP
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

function labelled(label, child) {
  return el('div', {}, [
    el('label', { class: 'block text-sm font-medium text-slate-700 mb-1', text: label }),
    child,
  ]);
}

function assignModalBody(lot, candidates, close) {
  const totalLotAvail = Number(lot.kg_green_actual ?? lot.kg_green_expected);
  const totalLotAllocated = (lot.assignments || []).reduce((s, a) => s + Number(a.kg_green_allocated || 0), 0);
  const lotRemaining = Math.max(0, totalLotAvail - totalLotAllocated);

  const inputs = new Map(); // order_id → input element
  const totalEl = el('strong', { text: '0' });
  const remEl   = el('strong', { text: fmtKg(lotRemaining) });

  function recalcTotal() {
    let total = 0;
    for (const inp of inputs.values()) total += Number(inp.value || 0);
    totalEl.textContent = fmtKg(total);
    remEl.textContent = fmtKg(lotRemaining - total);
    remEl.style.color = total > lotRemaining ? '#9f1239' : '';
  }

  const rows = candidates.map((o) => {
    const inp = el('input', {
      type: 'number', step: '0.01', min: '0', max: String(o.remaining_kg),
      placeholder: '0',
      class: 'w-28 px-2 py-1 rounded-lg border border-slate-300 text-right',
    });
    inp.addEventListener('input', () => recalcTotal());
    inputs.set(o.id, inp);
    return el('div', { class: 'flex flex-wrap items-center justify-between gap-2 py-2 border-b border-slate-100' }, [
      el('div', { class: 'min-w-0' }, [
        el('div', { class: 'flex items-center gap-2' }, [
          el('span', { class: 'font-mono text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700', text: o.order_code }),
          el('span', { class: 'truncate text-sm', text: o.reference_name || '' }),
        ]),
        el('div', { class: 'text-xs text-slate-600' }, [
          `Aceptado ${fmtKg(o.kg_green_accepted)} · Asignado ${fmtKg(o.allocated_kg)} · `,
          el('strong', {}, [`Disponible ${fmtKg(o.remaining_kg)}`]),
          ` · Entrega ${fmtDate(o.max_delivery_date)}`,
        ]),
      ]),
      el('div', { class: 'flex items-center gap-1' }, [
        inp,
        el('button', {
          type: 'button',
          class: 'text-xs px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700',
          onClick: () => { inp.value = String(Math.min(o.remaining_kg, lotRemaining - sumExcept(inputs, o.id))); recalcTotal(); },
        }, ['Llenar']),
      ]),
    ]);
  });

  return el('div', { class: 'space-y-3' }, [
    el('div', { class: 'rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm flex flex-wrap items-center gap-3' }, [
      el('span', {}, [`Disponible en lote: `, el('strong', { text: fmtKg(lotRemaining) })]),
      el('span', {}, [`Asignado en este modal: `, totalEl]),
      el('span', {}, [`Restante tras asignar: `, remEl]),
    ]),
    el('div', { class: 'max-h-[50vh] overflow-y-auto' }, rows),
    el('div', { class: 'flex justify-end gap-2 pt-2' }, [
      el('button', { class: 'px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700', type: 'button', onClick: () => close(null) }, ['Cancelar']),
      el('button', {
        class: 'px-4 py-2 rounded-lg bg-forest hover:bg-forest-dark text-white',
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
