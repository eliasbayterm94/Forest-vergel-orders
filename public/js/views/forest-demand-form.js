import { el } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { confirmModal, openModal } from '../ui/modal.js';
import { createCombobox, createMultiCombobox } from '../ui/combobox.js';
import { fmtKg } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { navigate } from '../router.js';

const PHYSICAL_ASPECTS = ['Verde', 'Verde amarillo', 'Amarillo', 'Amarillo-Marrón', 'Parduzco'];
const PROCESS_TYPES    = ['Natural', 'Honey', 'Lavado'];
const CHERRY_PER_GREEN = 7.65; // Display only; server is the source of truth.

export async function forestDemandFormView() {
  // Initial fetch of references + varieties (in parallel)
  const [refsRes, varsRes] = await Promise.all([api.references(), api.varieties()]);
  const allReferences = refsRes.references;
  const allVarieties  = varsRes.varieties;

  let selectedReference = null;
  let selectedVarieties = [];

  // ----- Variety multi-combo -----
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

  // ----- Reference combo -----
  const referenceCombo = createCombobox({
    placeholder: 'Buscar referencia...',
    items: allReferences,
    onChange: (item) => {
      selectedReference = item;
      // pre-fill varieties from the reference template if no manual selection yet
      if (item && selectedVarieties.length === 0 && Array.isArray(item.varieties)) {
        varietyCombo.setValues(item.varieties);
        selectedVarieties = item.varieties;
      }
    },
    onCreate: async (text) => {
      // open inline modal: name + variety multi-select
      const result = await openInlineReferenceModal(text, allVarieties);
      if (!result) return null;
      try {
        const r = await api.referenceSave({
          name: result.name,
          variety_ids: result.varieties.map((v) => v.id),
        });
        toast(`Referencia creada: ${r.reference.name}`, 'success');
        return r.reference;
      } catch (e) { toast(e.message, 'error'); return null; }
    },
    createLabel: '+ Crear referencia',
  });

  // ----- Other inputs -----
  const kgInput = el('input', {
    type: 'number', min: '0', step: '0.01', required: true,
    placeholder: 'Ej: 250',
    class: 'w-full px-3 py-2 rounded-lg border border-slate-300 focus:border-forest focus:ring-1 focus:ring-forest outline-none',
  });
  const cherryHint = el('p', { class: 'text-xs text-slate-500 mt-1', text: 'Equivale a — kg cereza' });
  kgInput.addEventListener('input', () => {
    const v = Number(kgInput.value || 0);
    cherryHint.textContent = `Equivale a ${fmtKg(v * CHERRY_PER_GREEN)} cereza`;
  });

  const dateInput = el('input', {
    type: 'date', required: true,
    class: 'w-full px-3 py-2 rounded-lg border border-slate-300 focus:border-forest focus:ring-1 focus:ring-forest outline-none',
  });

  const aspectSelect = el('select', {
    required: true,
    class: 'w-full px-3 py-2 rounded-lg border border-slate-300 bg-white focus:border-forest focus:ring-1 focus:ring-forest outline-none',
  }, [
    el('option', { value: '', disabled: true, selected: true }, ['Selecciona aspecto...']),
    ...PHYSICAL_ASPECTS.map((a) => el('option', { value: a }, [a])),
  ]);

  const processSelect = el('select', {
    required: true,
    class: 'w-full px-3 py-2 rounded-lg border border-slate-300 bg-white focus:border-forest focus:ring-1 focus:ring-forest outline-none',
  }, [
    el('option', { value: '', disabled: true, selected: true }, ['Selecciona proceso...']),
    ...PROCESS_TYPES.map((p) => el('option', { value: p }, [p])),
  ]);

  const fermInput = el('input', {
    type: 'number', min: '0', step: '0.5', placeholder: 'Opcional',
    class: 'w-full px-3 py-2 rounded-lg border border-slate-300 focus:border-forest focus:ring-1 focus:ring-forest outline-none',
  });

  const commentsInput = el('textarea', {
    rows: '3', placeholder: 'Notas adicionales...',
    class: 'w-full px-3 py-2 rounded-lg border border-slate-300 focus:border-forest focus:ring-1 focus:ring-forest outline-none',
  });

  const submitBtn = el('button', {
    type: 'submit',
    class: 'w-full sm:w-auto px-6 py-3 rounded-lg bg-forest hover:bg-forest-dark text-white font-medium',
  }, ['Crear pedido']);

  const form = el('form', {
    class: 'space-y-5 bg-white rounded-xl border border-slate-200 p-4 sm:p-6',
    onSubmit: async (e) => {
      e.preventDefault();
      if (!selectedReference) { toast('Selecciona una referencia', 'warning'); return; }
      const kg = Number(kgInput.value);
      if (!Number.isFinite(kg) || kg <= 0) { toast('Cantidad inválida', 'warning'); return; }
      if (!dateInput.value) { toast('Falta fecha de entrega', 'warning'); return; }
      if (!aspectSelect.value) { toast('Falta aspecto físico', 'warning'); return; }
      if (!processSelect.value) { toast('Falta proceso', 'warning'); return; }

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
      };
      await trySubmit(payload);
    },
  }, [
    section('Referencia', referenceCombo.el, 'Selecciona una existente o crea una nueva.'),
    section('Variedades', varietyCombo.el, 'Una o varias. Las de la referencia se cargan por defecto.'),
    section('Cantidad (kg verde)', el('div', {}, [kgInput, cherryHint])),
    section('Fecha máxima de entrega', dateInput),
    section('Aspecto físico', aspectSelect),
    section('Proceso', processSelect),
    section('Horas de fermentación', fermInput),
    section('Comentarios', commentsInput),
    el('div', { class: 'pt-2 flex flex-col sm:flex-row sm:justify-end gap-2' }, [
      el('button', {
        type: 'button',
        class: 'px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700',
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
    el('label', { class: 'block text-sm font-medium text-slate-700 mb-1', text: label }),
    child,
    hint ? el('p', { class: 'text-xs text-slate-500 mt-1', text: hint }) : null,
  ]);
}

function openInlineReferenceModal(initialName, allVarieties) {
  return openModal(({ close }) => {
    const nameInput = el('input', {
      type: 'text', value: initialName,
      class: 'w-full px-3 py-2 rounded-lg border border-slate-300 focus:border-forest focus:ring-1 focus:ring-forest outline-none',
    });
    let chosen = [];
    const vc = createMultiCombobox({
      placeholder: 'Variedades de la referencia...',
      items: allVarieties,
      onChange: (v) => { chosen = v; },
    });
    return el('div', { class: 'space-y-3' }, [
      el('label', { class: 'block text-sm font-medium text-slate-700' }, ['Nombre']),
      nameInput,
      el('label', { class: 'block text-sm font-medium text-slate-700 mt-2' }, ['Variedades']),
      vc.el,
      el('div', { class: 'flex justify-end gap-2 pt-3' }, [
        el('button', { class: 'px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          class: 'px-4 py-2 rounded-lg bg-forest hover:bg-forest-dark text-white',
          type: 'button',
          onClick: () => {
            const name = nameInput.value.trim();
            if (!name) { toast('Falta el nombre', 'warning'); return; }
            close({ name, varieties: chosen });
          },
        }, ['Guardar']),
      ]),
    ]);
  }, { title: 'Crear referencia', wide: true });
}
