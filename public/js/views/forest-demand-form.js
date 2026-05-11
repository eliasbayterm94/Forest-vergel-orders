import { el } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { confirmModal } from '../ui/modal.js';
import { createCombobox, createMultiCombobox } from '../ui/combobox.js';
import { fmtKg } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { navigate } from '../router.js';
import { bindValidation, setFieldError, clearFieldError } from '../ui/form-validation.js';

const PHYSICAL_ASPECTS = ['Verde', 'Verde amarillo', 'Amarillo', 'Amarillo-Marrón', 'Parduzco'];
const PROCESS_TYPES    = ['Natural', 'Honey', 'Lavado'];
const ORDER_TYPES      = ['Spot', 'Contract', 'FOB'];
const REGIONS          = ['USA', 'EU', 'UK', 'MENA', 'AU'];
const CHERRY_PER_GREEN = 7.65;

export async function forestDemandFormView() {
  const [refsRes, varsRes] = await Promise.all([api.references(), api.varieties()]);
  let allReferences  = refsRes.references;
  const allVarieties = varsRes.varieties;

  const rows = [];           // array de { node, getPayload, validate, setIndex, remove }
  const rowsContainer = el('div', { class: 'space-y-3' });

  function refreshIndices() {
    rows.forEach((r, i) => r.setIndex(i, rows.length));
  }

  function addRow() {
    const row = createOrderRow({
      index: rows.length,
      total: rows.length + 1,
      allReferences,
      allVarieties,
      onReferenceCreated: (ref) => {
        if (!allReferences.some((x) => x.id === ref.id)) {
          allReferences = [...allReferences, ref].sort((a, b) => a.name.localeCompare(b.name));
          rows.forEach((r) => r.setReferences(allReferences));
        }
      },
      onRemove: () => {
        if (rows.length === 1) {
          toast('Debe haber al menos un pedido', 'warning');
          return;
        }
        rowsContainer.removeChild(row.node);
        const idx = rows.indexOf(row);
        if (idx >= 0) rows.splice(idx, 1);
        refreshIndices();
        updateSubmitLabel();
      },
    });
    rows.push(row);
    rowsContainer.append(row.node);
    refreshIndices();
    updateSubmitLabel();
    return row;
  }

  const submitBtn = el('button', {
    type: 'submit',
    class: 'ctrm-btn ctrm-btn-yellow uppercase tracking-eyebrow text-[11px] py-3 px-6 w-full sm:w-auto',
  }, ['Crear pedido']);

  function updateSubmitLabel() {
    submitBtn.textContent = rows.length === 1 ? 'Crear pedido' : `Crear ${rows.length} pedidos`;
  }

  const addRowBtn = el('button', {
    type: 'button',
    class: 'w-full ctrm-btn ctrm-btn-soft py-3 border-dashed',
    onClick: () => {
      const row = addRow();
      row.focus();
      row.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
  }, ['+ Agregar otro pedido']);

  const form = el('form', {
    class: 'space-y-4',
    onSubmit: async (e) => {
      e.preventDefault();
      const allErrors = [];
      const payloads = [];
      rows.forEach((r, i) => {
        const result = r.validate();
        if (result.errors.length > 0) allErrors.push({ index: i, errors: result.errors });
        else payloads.push(result.payload);
      });
      if (allErrors.length > 0) {
        const first = allErrors[0];
        toast(`Pedido ${first.index + 1}: ${first.errors[0]}`, 'warning');
        rows[first.index].focus();
        return;
      }
      await trySubmit(payloads, false);
    },
  }, [
    rowsContainer,
    addRowBtn,
    el('div', { class: 'pt-3 flex flex-col sm:flex-row sm:justify-end gap-2 border-t border-sand' }, [
      el('button', {
        type: 'button',
        class: 'ctrm-btn ctrm-btn-ghost uppercase tracking-eyebrow text-[11px] py-3 px-6 w-full sm:w-auto',
        onClick: () => navigate('/forest/dashboard'),
      }, ['Cancelar']),
      submitBtn,
    ]),
  ]);

  async function trySubmit(orders, override) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Enviando...';
    try {
      const r = await api.orderCreateBulk({ orders, override_15_day: override });
      const n = (r.orders || []).length;
      toast(n === 1 ? `Pedido ${r.orders[0].order_code} creado` : `${n} pedidos creados`, 'success');
      navigate('/forest/dashboard');
    } catch (e) {
      if (e.code === 'FIFTEEN_DAY_RULE') {
        const offending = (e.detail && e.detail.rows_under_15_days) || [];
        const lines = offending.map((row) => `• Pedido ${row.index + 1}: ${row.days} día(s)`).join('\n');
        const ok = await confirmModal(
          `${offending.length} pedido(s) con entrega a menos de 15 días:\n\n${lines}\n\n¿Ya se confirmó con la planta de producción?`,
          { title: '⚠️ Plazo corto', confirmText: 'Confirmado, crear', cancelText: 'Volver', danger: true },
        );
        if (ok) {
          await trySubmit(orders, true);
          return;
        }
      } else if (e.code === 'VALIDATION_ERROR' && e.detail && e.detail.row_errors) {
        const first = e.detail.row_errors[0];
        toast(`Pedido ${first.index + 1}: ${first.errors[0]}`, 'error');
        if (rows[first.index]) rows[first.index].focus();
      } else if (e.code === 'INVALID_REFERENCE' && e.detail && e.detail.row_errors) {
        const first = e.detail.row_errors[0];
        toast(`Pedido ${first.index + 1}: referencia inválida`, 'error');
        if (rows[first.index]) rows[first.index].focus();
      } else {
        toast(e.message || 'Error al crear pedidos', 'error');
      }
    } finally {
      submitBtn.disabled = false;
      updateSubmitLabel();
    }
  }

  // Empezar con 1 fila
  addRow();

  return chrome(el('div', {}, [
    pageTitle('Nuevo pedido', 'Forest → El Vergel · puedes crear varios a la vez'),
    form,
  ]));
}

// ─── Fila individual ──────────────────────────────────────────────────
function createOrderRow({ index, allReferences, allVarieties, onReferenceCreated, onRemove }) {
  let selectedReference = null;
  let selectedVarieties = [];

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

  const referenceCombo = createCombobox({
    placeholder: 'Buscar referencia...',
    items: allReferences,
    onChange: (item) => {
      selectedReference = item;
      if (!item) return;
      if (item.process_type) processSelect.value = item.process_type;
      if (item.fermentation_hours != null && fermInput.value === '') {
        fermInput.value = String(item.fermentation_hours);
      }
    },
    onCreate: async (text) => {
      const name = (text || '').trim();
      if (!name) return null;
      try {
        const r = await api.referenceSave({
          name,
          process_type: processSelect.value || null,
          fermentation_hours: fermInput.value === '' ? null : Number(fermInput.value),
        });
        toast(`Referencia "${r.reference.name}" lista`, 'success');
        if (onReferenceCreated) onReferenceCreated(r.reference);
        return r.reference;
      } catch (e) { toast(e.message, 'error'); return null; }
    },
    createLabel: '+ Usar este nombre como nueva referencia',
  });

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

  bindValidation(kgInput,
    (v) => Number.isFinite(Number(v)) && Number(v) > 0,
    'Ingresa un número mayor a 0',
  );
  bindValidation(dateInput, (v) => !!v, 'Selecciona una fecha de entrega');
  bindValidation(processSelect, (v) => !!v, 'Selecciona un proceso');

  const aspectSelect = el('select', {
    required: true,
    class: 'ctrm-select',
  }, [
    el('option', { value: '', disabled: true, selected: true }, ['Selecciona aspecto...']),
    ...PHYSICAL_ASPECTS.map((a) => el('option', { value: a }, [a])),
  ]);

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
    rows: '2', placeholder: 'Notas adicionales...',
    class: 'ctrm-textarea',
  });

  const titleEl = el('p', { class: 'font-display font-semibold text-navy text-[14px]', text: `Pedido 1` });
  const removeBtn = el('button', {
    type: 'button',
    class: 'ctrm-btn ctrm-btn-ghost ctrm-btn-xs',
    title: 'Quitar este pedido',
    onClick: () => onRemove && onRemove(),
  }, ['✕ Quitar']);

  const node = el('div', { class: 'ctrm-card p-4 sm:p-5 space-y-4' }, [
    el('div', { class: 'flex items-center justify-between gap-2 pb-2 border-b border-sand' }, [
      titleEl,
      removeBtn,
    ]),
    section('Referencia', referenceCombo.el, 'Selecciona una existente o crea una nueva. Proceso y fermentación se autocompletan.'),
    section('Variedades', varietyCombo.el, 'Una o varias. Selección por pedido.'),
    el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-4' }, [
      section('Cantidad (kg verde)', el('div', {}, [kgInput, cherryHint])),
      section('Fecha máxima de entrega', dateInput),
    ]),
    el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-4' }, [
      section('Aspecto físico', aspectSelect),
      section('Proceso', processSelect),
    ]),
    el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-4' }, [
      section('Horas de fermentación', fermInput),
      section('Tipo de pedido', orderTypeSelect),
    ]),
    el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-4' }, [
      section('Cliente', clientInput),
      section('Código de contrato', contractInput),
    ]),
    section('Región (multiselección)', regionsRow),
    section('Comentarios', commentsInput),
  ]);

  function validate() {
    const errors = [];
    const kg = Number(kgInput.value);
    if (!selectedReference) errors.push('Selecciona una referencia');
    if (!Number.isFinite(kg) || kg <= 0) {
      setFieldError(kgInput, 'Ingresa un número mayor a 0');
      errors.push('Cantidad inválida');
    } else clearFieldError(kgInput);
    if (!dateInput.value) {
      setFieldError(dateInput, 'Selecciona una fecha de entrega');
      errors.push('Falta fecha de entrega');
    } else clearFieldError(dateInput);
    if (!processSelect.value) {
      setFieldError(processSelect, 'Selecciona un proceso');
      errors.push('Falta proceso');
    } else clearFieldError(processSelect);
    if (!aspectSelect.value) errors.push('Falta aspecto físico');

    if (errors.length > 0) return { errors, payload: null };

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
      order_type:    orderTypeSelect.value || null,
      client_name:   clientInput.value.trim() || null,
      regions:       selectedRegions.length > 0 ? selectedRegions : null,
      contract_code: contractInput.value.trim() || null,
    };
    return { errors: [], payload };
  }

  function setIndex(i, total) {
    titleEl.textContent = total > 1 ? `Pedido ${i + 1} de ${total}` : 'Pedido';
    removeBtn.style.visibility = total > 1 ? 'visible' : 'hidden';
  }

  function setReferences(refs) { referenceCombo.setItems(refs); }
  function focus() {
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => kgInput.focus(), 200);
  }

  return { node, validate, setIndex, setReferences, focus };
}

function section(label, child, hint) {
  return el('div', {}, [
    el('label', { class: 'ctrm-label', text: label }),
    child,
    hint ? el('p', { class: 'ctrm-hint', text: hint }) : null,
  ]);
}
