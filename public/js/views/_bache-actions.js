// Prompts y acciones compartidos del bache. Vivían dentro del closure
// de fincaLotsView; los extraje para reutilizarlos también desde la
// vista de detalle de bache.

import { el } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { openModal, confirmModal } from '../ui/modal.js';
import { fmtKg, statusLabel } from '../ui/format.js';
import { api } from '../api.js';

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

export function promptYield(lot, target) {
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
            close({ kg_dried_output: dried, factor_rendimiento: factor, kg_green_actual: green });
          },
        }, ['Confirmar']),
      ]),
    ]);
  }, { title: `Cambiar estado a ${statusLabel(target)}` });
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
  let dryingPayload = null;
  let restingPayload = null;

  if (isLeavingResting) {
    restingExitHumidity = await promptExitHumidity(lot, target);
    if (restingExitHumidity == null) return null;
  }

  if (target === 'Ready' && hasPartials) {
    const sumDried = partials.reduce((s, p) => s + Number(p.kg_dried || 0), 0);
    const sumGreen = partials.reduce((s, p) => s + Number(p.kg_green_yield || 0), 0);
    const ok = await confirmModal(
      `Cerrar bache ${lot.bache_code || lot.lot_code} con ${partials.length} parcial(es)? ` +
      `Total: ${fmtKg(sumDried)} seco · ${fmtKg(sumGreen)} verde.`,
      { title: 'Cerrar bache' },
    );
    if (!ok) return null;
  } else if (target === 'Ready' || target === 'Delivered') {
    yieldValues = await promptYield(lot, target);
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
  }
  return api.lotUpdateStatus(payload);
}
