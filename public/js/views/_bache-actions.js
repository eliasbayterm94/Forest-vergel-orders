// Prompts y acciones compartidos del bache. Vivían dentro del closure
// de fincaLotsView; los extraje para reutilizarlos también desde la
// vista de detalle de bache.

import { el } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { openModal, confirmModal } from '../ui/modal.js';
import { fmtKg, statusLabel } from '../ui/format.js';
import { api } from '../api.js';
import { createMultiCombobox, createCombobox } from '../ui/combobox.js';
import { withBusy } from '../ui/busy.js';

export const PROCESS_TYPES = ['Natural', 'Honey', 'Lavado'];

export const DRYING_LOCATIONS = ['Silos', 'Patio'];
export const INPUT_STAGE_DIVISORS = { cereza: 7.65, despulpado: 4.20, seco: 1.34 };
export const KG_PER_SACO = 70;

// Transiciones disponibles desde cada estado. `primary` define la
// acción visible (botón único en tabla, primario en card). `secondary`
// son acciones alternativas (kebab en tabla, soft en card).
export const NEXT_TRANSITIONS = {
  InFermentation: {
    primary:   { target: 'Drying',  label: '→ Secado' },
    secondary: [],
  },
  Drying: {
    primary:   { target: 'Resting', label: '→ Descanso' },
    secondary: [{ target: 'Ready',  label: 'Saltar a Listo' }],
  },
  Resting: {
    primary:   { target: 'Ready',  label: '→ Listo' },
    secondary: [{ target: 'Drying', label: 'Volver a Secado' }],
  },
  Ready: {
    primary:   null,
    secondary: [],
  },
};

// ── Prompts ─────────────────────────────────────────────────────────

export function promptDrying(lot, isReturn) {
  return openModal(({ close }) => {
    const defaultDate = new Date().toISOString().slice(0, 10);
    const dateInput = el('input', { type: 'date', value: defaultDate, class: 'ctrm-input' });
    const checkboxes = DRYING_LOCATIONS.map((loc) => {
      const cb = el('input', { type: 'checkbox', value: loc, class: 'mr-2' });
      if (!isReturn && (lot.drying_locations || []).includes(loc)) cb.checked = true;
      return { loc, cb };
    });
    const locWrap = el('div', { class: 'flex flex-wrap gap-3' },
      checkboxes.map(({ loc, cb }) => el('label', {
        class: 'inline-flex items-center text-[13px] text-ink-700 cursor-pointer px-3 py-2 border border-sand rounded-md hover:bg-cream',
      }, [cb, el('span', { text: loc })])));
    return el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-[12px] text-ink-700 leading-relaxed' }, [
        isReturn ? `Devolviendo ` : `Avanzando `,
        el('strong', { class: 'text-navy', text: lot.bache_code || lot.lot_code }),
        ` a `, el('strong', { class: 'text-navy', text: 'Secado' }),
        isReturn
          ? `. Elige las marquesinas donde lo metés esta vez.`
          : `. Registramos la fecha de entrada y dónde se está secando.`,
      ]),
      el('label', { class: 'ctrm-label', text: 'Fecha de inicio de secado' }),
      dateInput,
      el('div', {}, [
        el('label', { class: 'ctrm-label' }, [
          'Marquesinas ',
          el('span', { class: 'ctrm-req', text: '*' }),
        ]),
        locWrap,
        el('p', { class: 'ctrm-hint', text: 'Marca una o más. Se puede combinar Silos + Patio.' }),
      ]),
      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-primary',
          type: 'button',
          onClick: () => {
            if (!dateInput.value) { toast('Selecciona una fecha', 'warning'); return; }
            const picked = checkboxes.filter(({ cb }) => cb.checked).map(({ loc }) => loc);
            if (picked.length === 0) { toast('Selecciona al menos una marquesina', 'warning'); return; }
            close({ drying_start_date: dateInput.value, drying_locations: picked });
          },
        }, [isReturn ? 'Volver a Secado' : 'Avanzar a Secado']),
      ]),
    ]);
  }, { title: isReturn ? 'Regreso a Secado' : 'Inicio de secado' });
}

export function promptResting(lot) {
  return openModal(({ close }) => {
    const dateInput = el('input', {
      type: 'date', value: new Date().toISOString().slice(0, 10), class: 'ctrm-input',
    });
    const humInput = el('input', {
      type: 'number', min: '8', max: '40', step: '0.1',
      placeholder: 'Ej: 18.5',
      class: 'ctrm-input mono',
    });
    const ruleHint = el('p', { class: 'ctrm-hint mt-1' });
    function refreshRuleHint() {
      const v = Number(humInput.value);
      if (!Number.isFinite(v) || v <= 0) { ruleHint.textContent = 'Rango válido: 8% a 40%.'; ruleHint.style.color = ''; return; }
      if (v > 20)       { ruleHint.textContent = `${v}% · Máx 5 días en descanso antes de volver a secado.`; ruleHint.style.color = '#a8351c'; }
      else if (v >= 14) { ruleHint.textContent = `${v}% · Máx 8 días en descanso antes de volver a secado.`; ruleHint.style.color = '#8a5100'; }
      else              { ruleHint.textContent = `${v}% · Listo para pasar a Listo sin restricción.`;          ruleHint.style.color = '#2f5a3a'; }
    }
    humInput.addEventListener('input', refreshRuleHint);
    refreshRuleHint();
    return el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-[12px] text-ink-700 leading-relaxed' }, [
        `Avanzando `, el('strong', { class: 'text-navy', text: lot.bache_code || lot.lot_code }),
        ` a `, el('strong', { class: 'text-navy', text: 'Descanso' }),
        `. Registramos la fecha de entrada y la humedad de control del bache.`,
      ]),
      el('label', { class: 'ctrm-label', text: 'Fecha de entrada a descanso' }),
      dateInput,
      el('div', {}, [
        el('label', { class: 'ctrm-label' }, [
          'Humedad % ',
          el('span', { class: 'ctrm-req', text: '*' }),
        ]),
        humInput,
        ruleHint,
      ]),
      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-primary',
          type: 'button',
          onClick: () => {
            if (!dateInput.value) { toast('Selecciona una fecha', 'warning'); return; }
            const v = Number(humInput.value);
            if (!Number.isFinite(v) || v < 8 || v > 40) {
              toast('Humedad: ingresa un valor entre 8 y 40', 'warning'); return;
            }
            close({ resting_start_date: dateInput.value, resting_humidity: v });
          },
        }, ['Avanzar a Descanso']),
      ]),
    ]);
  }, { title: 'Entrada a Descanso' });
}

export function promptExitHumidity(lot, target) {
  return openModal(({ close }) => {
    const humInput = el('input', {
      type: 'number', min: '8', max: '40', step: '0.1',
      placeholder: 'Ej: 12.5',
      class: 'ctrm-input mono',
    });
    const targetLabel = target === 'Drying' ? 'volver a Secado' : 'pasar a Listo';
    const entryHum = lot.resting_humidity != null ? `${lot.resting_humidity}%` : '—';
    return el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-[12px] text-ink-700 leading-relaxed' }, [
        `El bache `, el('strong', { class: 'text-navy', text: lot.bache_code || lot.lot_code }),
        ` va a `, el('strong', { class: 'text-navy', text: targetLabel }),
        `. Antes registramos la humedad actual del bache.`,
      ]),
      el('p', { class: 'text-[11px] text-ink-500 font-mono', text: `Humedad de entrada al descanso: ${entryHum}` }),
      el('div', {}, [
        el('label', { class: 'ctrm-label' }, [
          'Humedad de salida % ',
          el('span', { class: 'ctrm-req', text: '*' }),
        ]),
        humInput,
        el('p', { class: 'ctrm-hint', text: 'Rango 8% a 40%.' }),
      ]),
      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-primary',
          type: 'button',
          onClick: () => {
            const v = Number(humInput.value);
            if (!Number.isFinite(v) || v < 8 || v > 40) {
              toast('Humedad: ingresa un valor entre 8 y 40', 'warning'); return;
            }
            close(v);
          },
        }, ['Continuar']),
      ]),
    ]);
  }, { title: 'Humedad de salida del descanso' });
}

export function promptYield(lot, target, opts = {}) {
  const isReady = target === 'Ready';
  // Para Resting → Ready la humedad ya se capturó como exit_humidity;
  // ahí no la pedimos otra vez. Para Drying → Ready directo, sí.
  const askHumidity = isReady && opts.askHumidity !== false;
  // La fecha solo aplica a Ready (Delivered ya no la usa este prompt).
  const askDate = isReady;
  const today = new Date().toISOString().slice(0, 10);
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
    const dateInput = askDate ? el('input', {
      type: 'date', value: today, class: 'ctrm-input',
    }) : null;
    const humidityInput = askHumidity ? el('input', {
      type: 'number', step: '0.1', min: '0', max: '100',
      placeholder: 'Ej: 11.0', class: 'ctrm-input mono',
    }) : null;
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
      askDate ? el('label', { class: 'ctrm-label mt-2', text: 'Fecha de cierre (Listo)' }) : null,
      dateInput,
      askHumidity ? el('label', { class: 'ctrm-label mt-2', text: 'Humedad final (%)' }) : null,
      humidityInput,
      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
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
            const ready_date = dateInput && dateInput.value ? dateInput.value : null;
            const humidity = humidityInput && humidityInput.value !== '' ? Number(humidityInput.value) : null;
            if (humidity != null && !(humidity >= 0 && humidity <= 100)) {
              toast('Humedad debe estar entre 0 y 100', 'warning'); return;
            }
            close({
              kg_dried_output: dried, factor_rendimiento: factor, kg_green_actual: green,
              ready_date, final_humidity: humidity,
            });
          },
        }, ['Confirmar']),
      ]),
    ]);
  }, { title: `Cambiar estado a ${statusLabel(target)}` });
}

// Modal para cerrar un bache con parciales (Drying/Resting → Ready).
// Pide fecha de cierre y, si no venimos de Resting (donde la exit
// humidity ya cubre eso), la humedad final.
export function promptCloseBache(lot, partials, opts = {}) {
  const askHumidity = opts.askHumidity !== false;
  const today = new Date().toISOString().slice(0, 10);
  const sumDried = partials.reduce((s, p) => s + Number(p.kg_dried || 0), 0);
  const sumGreen = partials.reduce((s, p) => s + Number(p.kg_green_yield || 0), 0);
  return openModal(({ close }) => {
    const dateInput = el('input', { type: 'date', value: today, class: 'ctrm-input' });
    const humInput = askHumidity ? el('input', {
      type: 'number', step: '0.1', min: '0', max: '100',
      placeholder: 'Ej: 11.0', class: 'ctrm-input mono',
    }) : null;
    return el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-[12px] text-ink-700 leading-relaxed' }, [
        `Cerrando bache `, el('strong', { class: 'text-navy', text: lot.bache_code || lot.lot_code }),
        ` con `, el('strong', { text: `${partials.length} parcial(es)` }), `.`,
      ]),
      el('p', { class: 'text-[11px] font-mono text-ink-500',
        text: `Total: ${fmtKg(sumDried)} seco · ${fmtKg(sumGreen)} verde` }),
      el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'Fecha de cierre (Listo)' }),
        dateInput,
      ]),
      askHumidity ? el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'Humedad final (%)' }),
        humInput,
        el('p', { class: 'ctrm-hint', text: 'Opcional. Queda en el registro del lote.' }),
      ]) : null,
      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-primary', type: 'button',
          onClick: () => {
            const ready_date = dateInput.value || null;
            if (!ready_date) { toast('Indica la fecha de cierre', 'warning'); return; }
            const humidity = humInput && humInput.value !== '' ? Number(humInput.value) : null;
            if (humidity != null && !(humidity >= 0 && humidity <= 100)) {
              toast('Humedad debe estar entre 0 y 100', 'warning'); return;
            }
            close({ ready_date, final_humidity: humidity });
          },
        }, ['Cerrar bache']),
      ]),
    ]);
  }, { title: 'Cerrar bache' });
}

// ── Advance status (helper compartido) ──────────────────────────────
//
// Construye el payload via los prompts apropiados, llama al endpoint
// y devuelve la respuesta. Si el usuario cancela cualquier prompt,
// retorna null. Errores se propagan (callee maneja el toast).
export async function advanceStatus(lot, target) {
  const partials = lot.partials || [];
  const hasPartials = partials.length > 0;
  const isReturnToDrying = lot.status === 'Resting' && target === 'Drying';
  const isLeavingResting = lot.status === 'Resting' && (target === 'Drying' || target === 'Ready');

  let restingExitHumidity = null;
  let yieldValues = null;
  let closeMeta = null;
  let dryingPayload = null;
  let restingPayload = null;

  if (isLeavingResting) {
    restingExitHumidity = await promptExitHumidity(lot, target);
    if (restingExitHumidity == null) return null;
  }

  if (target === 'Ready' && hasPartials) {
    // Path con parciales: confirma + pide fecha + humedad final.
    // Si viene de Resting, la humedad ya quedó capturada como exit
    // humidity → no la pedimos otra vez aquí.
    closeMeta = await promptCloseBache(lot, partials, { askHumidity: !isLeavingResting });
    if (closeMeta == null) return null;
  } else if (target === 'Ready' || target === 'Delivered') {
    yieldValues = await promptYield(lot, target, { askHumidity: !isLeavingResting });
    if (yieldValues == null) return null;
  } else if (target === 'Drying') {
    dryingPayload = await promptDrying(lot, isReturnToDrying);
    if (!dryingPayload) return null;
  } else if (target === 'Resting') {
    restingPayload = await promptResting(lot);
    if (!restingPayload) return null;
  } else {
    const ok = await confirmModal(`Avanzar ${lot.bache_code || lot.lot_code} a "${statusLabel(target)}"?`, { title: 'Cambio de estado' });
    if (!ok) return null;
  }

  const payload = { lot_id: lot.id, status: target };
  if (dryingPayload) {
    payload.drying_start_date = dryingPayload.drying_start_date;
    payload.drying_locations  = dryingPayload.drying_locations;
  }
  if (restingPayload) {
    payload.resting_start_date = restingPayload.resting_start_date;
    payload.resting_humidity   = restingPayload.resting_humidity;
  }
  if (restingExitHumidity != null) payload.resting_exit_humidity = restingExitHumidity;
  if (yieldValues) {
    if (yieldValues.kg_dried_output    != null) payload.kg_dried_output    = yieldValues.kg_dried_output;
    if (yieldValues.factor_rendimiento != null) payload.factor_rendimiento = yieldValues.factor_rendimiento;
    if (yieldValues.kg_green_actual    != null) payload.kg_green_actual    = yieldValues.kg_green_actual;
    if (yieldValues.ready_date         != null) payload.ready_date         = yieldValues.ready_date;
    if (yieldValues.final_humidity     != null) payload.final_humidity     = yieldValues.final_humidity;
  }
  if (closeMeta) {
    if (closeMeta.ready_date     != null) payload.ready_date     = closeMeta.ready_date;
    if (closeMeta.final_humidity != null) payload.final_humidity = closeMeta.final_humidity;
  }
  return api.lotUpdateStatus(payload);
}

// ── Editar datos principales del bache ─────────────────────────────
// Variedad, kg inicial, observaciones, fecha inicial, proceso, horas
// de fermentación, infusión + %. El código de bache también puede
// actualizarse. Bloqueado si lot.status === 'Delivered'.
export async function editBacheModal(lot) {
  if (lot.status === 'Delivered') {
    toast('No se puede editar un bache ya despachado.', 'warning', 5000);
    return null;
  }
  // Cargamos variedades + infusiones en paralelo. Las cacheamos en el
  // closure del modal (no compartido entre llamadas).
  const [vRes, iRes] = await Promise.all([
    api.varieties(),
    api.infusions().catch(() => ({ infusions: [] })),
  ]);
  const allVarieties = vRes.varieties || [];
  const allInfusions = (iRes && iRes.infusions) || [];

  return openModal(({ close }) => {
    const codeInput = el('input', {
      type: 'text', value: lot.bache_code || '',
      class: 'ctrm-input mono uppercase', maxlength: '60',
    });
    const dateInput = el('input', {
      type: 'date', value: lot.start_date || '', class: 'ctrm-input',
    });
    const stageInputLabel = lot.processing_stage === 'cereza'     ? 'kg de cereza fresca'
                          : lot.processing_stage === 'despulpado' ? 'kg de café despulpado'
                          : lot.processing_stage === 'seco'       ? 'kg de café seco' : 'kg inicial';
    const kgInput = el('input', {
      type: 'number', min: '0', step: '0.01',
      value: lot.kg_input_initial != null ? String(lot.kg_input_initial) : '',
      class: 'ctrm-input mono',
    });
    const procSelect = el('select', { class: 'ctrm-select' },
      PROCESS_TYPES.map((p) => el('option', { value: p, selected: lot.process_type === p }, [p])));
    const fermInput = el('input', {
      type: 'number', min: '0', step: '0.5', placeholder: 'Opcional',
      value: lot.fermentation_hours != null ? String(lot.fermentation_hours) : '',
      class: 'ctrm-input mono',
    });
    const vCombo = createMultiCombobox({
      placeholder: 'Variedades...',
      items: allVarieties,
      values: (lot.varieties || []).map((v) => ({ id: v.id, name: v.name })),
      onCreate: async (text) => {
        try {
          const r = await api.varietyAdd(text);
          toast(`Variedad creada: ${r.variety.name}`, 'success');
          return r.variety;
        } catch (e) { toast(e.message, 'error'); return null; }
      },
      createLabel: '+ Crear variedad',
    });
    const notesInput = el('textarea', { rows: '3', class: 'ctrm-textarea' });
    notesInput.value = lot.notes || '';

    // Infusión (opcional). Si tenía, se pre-selecciona.
    let chosenInfusion = lot.infusion_id
      ? (allInfusions.find((i) => i.id === lot.infusion_id) || { id: lot.infusion_id, name: lot.infusion_name || '' })
      : null;
    const infCombo = createCombobox({
      placeholder: 'Sin infusión',
      items: allInfusions,
      initialValue: chosenInfusion,
      onChange: (item) => { chosenInfusion = item || null; refreshInfusionVisibility(); },
      onCreate: async (text) => {
        try {
          const r = await api.infusionAdd(text);
          allInfusions.push(r.infusion);
          allInfusions.sort((a, b) => a.name.localeCompare(b.name));
          infCombo.setItems(allInfusions);
          return r.infusion;
        } catch (e) { toast(e.message, 'error'); return null; }
      },
      createLabel: '+ Crear infusión',
    });
    const infPctInput = el('input', {
      type: 'number', min: '0.5', step: '0.5', max: '100',
      value: lot.infusion_pct != null ? String(lot.infusion_pct) : '',
      placeholder: '% sobre el peso de entrada',
      class: 'ctrm-input mono',
    });
    const infPctWrap = el('div', { class: 'mt-2', hidden: chosenInfusion ? undefined : 'true' }, [
      el('label', { class: 'ctrm-label', text: '% de infusión' }),
      infPctInput,
    ]);
    function refreshInfusionVisibility() {
      if (chosenInfusion) infPctWrap.removeAttribute('hidden');
      else infPctWrap.setAttribute('hidden', 'true');
    }

    return el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-[12px] text-ink-500' }, [
        'Lote interno: ', el('strong', { class: 'font-mono text-ink-700', text: lot.lot_code }),
        lot.processing_stage ? ` · stage ${lot.processing_stage}` : '',
      ]),

      labelled('Código de bache', codeInput),
      labelled('Fecha de inicio', dateInput),
      labelled(stageInputLabel, kgInput),
      labelled('Proceso', procSelect),
      labelled('Horas de fermentación', fermInput),

      el('div', {}, [
        el('label', { class: 'ctrm-label' }, [
          'Variedades ',
          el('span', { class: 'ctrm-req', text: '*' }),
        ]),
        vCombo.el,
      ]),

      el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'Infusión (opcional)' }),
        infCombo.el,
      ]),
      infPctWrap,

      labelled('Observaciones', notesInput),

      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-primary',
          type: 'button',
          onClick: async (e) => {
            const btn = e.currentTarget;
            const code = codeInput.value.trim();
            const startDate = dateInput.value || null;
            const kg = kgInput.value === '' ? null : Number(kgInput.value);
            const proc = procSelect.value;
            const ferm = fermInput.value === '' ? null : Number(fermInput.value);
            const varietyIds = vCombo.getValues().map((v) => v.id);
            const infPct = chosenInfusion ? Number(infPctInput.value) : null;
            const notesVal = notesInput.value.trim();
            if (!code) { toast('Código requerido', 'warning'); return; }
            if (!startDate) { toast('Fecha de inicio requerida', 'warning'); return; }
            if (kg == null || !(kg > 0)) { toast('kg inicial debe ser > 0', 'warning'); return; }
            if (!proc) { toast('Selecciona proceso', 'warning'); return; }
            if (varietyIds.length === 0) { toast('Al menos una variedad', 'warning'); return; }
            if (chosenInfusion && (!Number.isFinite(infPct) || infPct <= 0 || infPct > 100)) {
              toast('Infusión: indica un % entre 0 y 100', 'warning'); return;
            }
            const fields = {
              bache_code: code,
              start_date: startDate,
              kg_input_initial: kg,
              process_type: proc,
              fermentation_hours: ferm,
              notes: notesVal || null,
              infusion_id:  chosenInfusion ? chosenInfusion.id : null,
              infusion_pct: chosenInfusion ? infPct : null,
            };
            try {
              await withBusy(btn, 'Guardando…', () =>
                api.lotUpdate({ lot_id: lot.id, fields, variety_ids: varietyIds }));
              toast(`Bache ${code} actualizado`, 'success');
              close({ ok: true });
            } catch (err) {
              console.error('lotUpdate failed', err);
              toast(err.message || 'Error al guardar', 'error', 6000);
            }
          },
        }, ['Guardar']),
      ]),
    ]);
  }, { title: 'Editar bache', wide: true });
}

function labelled(label, control) {
  return el('div', {}, [
    el('label', { class: 'ctrm-label', text: label }),
    control,
  ]);
}
