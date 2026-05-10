import { el } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { confirmModal } from '../ui/modal.js';
import { createCombobox, createMultiCombobox } from '../ui/combobox.js';
import { fmtKg } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { navigate } from '../router.js';
import { openReferenceModal } from './forest-references.js';

const PHYSICAL_ASPECTS = ['Verde', 'Verde amarillo', 'Amarillo', 'Amarillo-Marrón', 'Parduzco'];
const PROCESS_TYPES    = ['Natural', 'Honey', 'Lavado'];
const ORDER_TYPES      = ['Spot', 'Contract', 'FOB'];
const REGIONS          = ['USA', 'EU', 'UK', 'MENA', 'AU'];
const CHERRY_PER_GREEN = 7.65; // Display only; server is the source of truth.

export async function forestDemandFormView() {
  const [refsRes, varsRes] = await Promise.all([api.references(), api.varieties()]);
  let allReferences  = refsRes.references;
  const allVarieties = varsRes.varieties;

  let selectedReference = null;
  let selectedVarieties = [];

  // ----- Variety multi-combo (per-order, independent of reference) -----
  const varietyCombo = createMultiCombobox({
    placeholder: 'Buscar variedades...',
    items: allVarieties,
    values: [],
    onChange: (v) => { selectedVarieties = v; },
    onCreate: async (text) => {
      try {
        const r = await api.varietyAdd(text);
        toast(`Variedad creada: ${r.variety.name}`, 'success');
        return r.variety;
      } catch (e) { toast(e.message, 'error'); return null; }
    },
    createLabel: '+ Crear variedad',
  });

  // ----- Other inputs (declared first so the reference combo can pre-fill them) -----
  const processSelect = el('select', {
    required: true,
    class: 'ctrm-select',
  }, [
    el('option', { value: '', disabled: true, selected: true }, ['Selecciona proceso...']),
    ...PROCESS_TYPES.map((p) => el('option', { value: p }, [p])),
  ]);

  const fermInput = el('input', {
    type: 'number', min: '0', step: '0.5', placeholder: 'Opcional',
    class: 'ctrm-input mono',
  });

  // ----- Reference combo (auto-fills proceso + fermentación) -----
  const referenceCombo = createCombobox({
    placeholder: 'Buscar referencia...',
    items: allReferences,
    onChange: (item) => {
      selectedReference = item;
      if (!item) return;
      // Auto-fill the process select from the reference template
      if (item.process_type && !processSelect.value) {
        processSelect.value = item.process_type;
      } else if (item.process_type) {
        // Always respect the reference's process unless user explicitly changed it
        processSelect.value = item.process_type;
      }
      // Auto-fill fermentation hours if not set
      if (item.fermentation_hours != null && fermInput.value === '') {
        fermInput.value = String(item.fermentation_hours);
      }
    },
    onCreate: async (text) => {
      const name = (text || '').trim();
      if (!name) return null;
      try {
        // Quick-create: solo nombre + proceso si ya esta elegido en el form.
        // No abrimos el modal para que el flujo sea de un click — la
        // referencia se puede completar despues desde /forest/references.
        const r = await api.referenceSave({
          name,
          process_type: processSelect.value || null,
          fermentation_hours: fermInput.value === '' ? null : Number(fermInput.value),
        });
        toast(`Referencia "${r.reference.name}" lista`, 'success');
        // Append to local list so the dropdown sees it next time it opens
        if (!allReferences.some((x) => x.id === r.reference.id)) {
          allReferences = [...allReferences, r.reference]
            .sort((a, b) => a.name.localeCompare(b.name));
          referenceCombo.setItems(allReferences);
        }
        return r.reference;
      } catch (e) { toast(e.message, 'error'); return null; }
    },
    createLabel: '+ Usar este nombre como nueva referencia',
  });

  // ----- Numeric / date / textarea inputs -----
  const kgInput = el('input', {
    type: 'number', min: '0', step: '0.01', required: true,
    placeholder: 'Ej: 250',
    class: 'ctrm-input mono',
  });
  const cherryHint = el('p', { class: 'ctrm-hint', text: 'Equivale a — kg cereza' });
  kgInput.addEventListener('input', () => {
    const v = Number(kgInput.value || 0);
    cherryHint.textContent = `Equivale a ${fmtKg(v * CHERRY_PER_GREEN)} cereza`;
  });

  const dateInput = el('input', {
    type: 'date', required: true,
    class: 'ctrm-input',
  });

  const aspectSelect = el('select', {
    required: true,
    class: 'ctrm-select',
  }, [
    el('option', { value: '', disabled: true, selected: true }, ['Selecciona aspecto...']),
    ...PHYSICAL_ASPECTS.map((a) => el('option', { value: a }, [a])),
  ]);

  // ─── Commercial metadata (new fields) ───
  const orderTypeSelect = el('select', { class: 'ctrm-select' }, [
    el('option', { value: '', selected: true }, ['Selecciona tipo...']),
    ...ORDER_TYPES.map((t) => el('option', { value: t }, [t])),
  ]);

  const clientInput = el('input', {
    type: 'text', placeholder: 'Cliente (opcional)',
    class: 'ctrm-input',
    autocomplete: 'off',
  });

  const contractInput = el('input', {
    type: 'text', placeholder: 'Código alfanumérico (opcional)',
    class: 'ctrm-input mono',
    autocomplete: 'off',
  });

  const regionInputs = REGIONS.map((r) => {
    const cb = el('input', { type: 'checkbox', value: r, class: 'h-4 w-4 accent-navy mr-1.5' });
    return { region: r, input: cb, node: el('label', { class: 'inline-flex items-center px-2 py-1 rounded-md border border-sand bg-white text-[12px] font-medium text-ink-700 cursor-pointer hover:border-navy' }, [cb, r]) };
  });
  const regionsRow = el('div', { class: 'flex flex-wrap gap-2' }, regionInputs.map((r) => r.node));

  const commentsInput = el('textarea', {
    rows: '3', placeholder: 'Notas adicionales...',
    class: 'ctrm-textarea',
  });

  const submitBtn = el('button', {
    type: 'submit',
    class: 'ctrm-btn ctrm-btn-yellow uppercase tracking-eyebrow text-[11px] py-3 px-6 w-full sm:w-auto',
  }, ['Crear pedido']);

  const form = el('form', {
    class: 'space-y-5 ctrm-card p-4 sm:p-6',
    onSubmit: async (e) => {
      e.preventDefault();
      if (!selectedReference) { toast('Selecciona una referencia', 'warning'); return; }
      const kg = Number(kgInput.value);
      if (!Number.isFinite(kg) || kg <= 0) { toast('Cantidad inválida', 'warning'); return; }
      if (!dateInput.value) { toast('Falta fecha de entrega', 'warning'); return; }
      if (!aspectSelect.value) { toast('Falta aspecto físico', 'warning'); return; }
      if (!processSelect.value) { toast('Falta proceso', 'warning'); return; }

      const selectedRegions = regionInputs.filter((r) => r.input.checked).map((r) => r.region);

      const payload = {
        reference_id: selectedReference.id,
        variety_ids:  selectedVarieties.map((v) => v.id),
        kg_green_required: kg,
        max_delivery_date: dateInput.value,
        physical_aspect:   aspectSelect.value,
        process_type:      processSelect.value,
        fermentation_hours: fermInput.value === '' ? null : Number(fermInput.value),
        comments: commentsInput.value || null,
        override_15_day: false,
        order_type:    orderTypeSelect.value || null,
        client_name:   clientInput.value.trim() || null,
        regions:       selectedRegions.length > 0 ? selectedRegions : null,
        contract_code: contractInput.value.trim() || null,
      };
      await trySubmit(payload);
    },
  }, [
    section('Referencia', referenceCombo.el, 'Selecciona una existente o crea una nueva. Proceso y fermentación se autocompletan desde la referencia.'),
    section('Variedades', varietyCombo.el, 'Una o varias. Selección por pedido.'),
    section('Cantidad (kg verde)', el('div', {}, [kgInput, cherryHint])),
    section('Fecha máxima de entrega', dateInput),
    section('Aspecto físico', aspectSelect),
    section('Proceso', processSelect),
    section('Horas de fermentación', fermInput),

    // Commercial metadata block
    el('div', { class: 'pt-3 border-t border-sand' }, [
      el('p', { class: 'eyebrow mb-3', text: 'Metadatos comerciales (opcionales)' }),
      el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-4' }, [
        section('Tipo de pedido', orderTypeSelect),
        section('Cliente', clientInput),
      ]),
      el('div', { class: 'mt-3' }, section('Región (multiselección)', regionsRow)),
      el('div', { class: 'mt-3' }, section('Código de contrato', contractInput)),
    ]),

    section('Comentarios', commentsInput),
    el('div', { class: 'pt-3 flex flex-col sm:flex-row sm:justify-end gap-2 border-t border-sand' }, [
      el('button', {
        type: 'button',
        class: 'ctrm-btn ctrm-btn-ghost uppercase tracking-eyebrow text-[11px] py-3 px-6 w-full sm:w-auto',
        onClick: () => navigate('/forest/dashboard'),
      }, ['Cancelar']),
      submitBtn,
    ]),
  ]);

  async function trySubmit(payload) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Enviando...';
    try {
      const r = await api.orderCreate(payload);
      toast(`Pedido ${r.order.order_code} creado`, 'success');
      navigate('/forest/dashboard');
    } catch (e) {
      if (e.code === 'FIFTEEN_DAY_RULE') {
        const days = e.detail?.days_to_delivery;
        const ok = await confirmModal(
          `La fecha de entrega es en ${days} día(s) (menos de 15). ¿Ya se confirmó con la planta de producción la viabilidad de este pedido?`,
          { title: '⚠️ Plazo corto', confirmText: 'Confirmado, crear', cancelText: 'Volver', danger: true },
        );
        if (ok) {
          payload.override_15_day = true;
          await trySubmit(payload);
          return;
        }
      } else {
        toast(e.message || 'Error al crear pedido', 'error');
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Crear pedido';
    }
  }

  return chrome(el('div', {}, [
    pageTitle('Nuevo pedido', 'Forest → El Vergel'),
    form,
  ]));
}

function section(label, child, hint) {
  return el('div', {}, [
    el('label', { class: 'ctrm-label', text: label }),
    child,
    hint ? el('p', { class: 'ctrm-hint', text: hint }) : null,
  ]);
}
