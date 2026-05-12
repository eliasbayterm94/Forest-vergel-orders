// Bulk demand-order entry — table layout for power users.
// Each row is a TR with native inputs/selects so TAB-navigation is fast.
// Comboboxes are avoided here on purpose: the table needs to scroll and
// floating dropdowns would clip. New references/varieties created on
// the fly happen in the single-pedido form (/forest/demand).

import { el } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { confirmModal } from '../ui/modal.js';
import { fmtKg } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { navigate } from '../router.js';

const PHYSICAL_ASPECTS = ['Verde', 'Verde amarillo', 'Amarillo', 'Amarillo-Marrón', 'Parduzco'];
const PROCESS_TYPES    = ['Natural', 'Honey', 'Lavado'];
const ORDER_TYPES      = ['Spot', 'Contract', 'FOB'];
const REGIONS          = ['USA', 'EU', 'UK', 'MENA', 'AU'];
const CHERRY_PER_GREEN = 7.65;

export async function forestDemandBulkFormView() {
  const [refsRes, varsRes] = await Promise.all([api.references(), api.varieties()]);
  let allReferences = refsRes.references || [];
  let allVarieties  = varsRes.varieties  || [];

  // Datalists compartidos por todas las filas. Los refrescamos cuando
  // se crean nuevos items para que el autocomplete refleje la lista
  // actualizada.
  const varietyDatalistId = 'forest-bulk-variety-list';
  const refDatalistId     = 'forest-bulk-ref-list';
  const varietyDatalist = el('datalist', { id: varietyDatalistId },
    allVarieties.map((v) => el('option', { value: v.name })));
  const refDatalist = el('datalist', { id: refDatalistId },
    allReferences.map((r) => el('option', { value: r.name })));
  document.body.append(varietyDatalist, refDatalist);

  function refreshVarietyDatalist() {
    while (varietyDatalist.firstChild) varietyDatalist.removeChild(varietyDatalist.firstChild);
    for (const v of allVarieties) varietyDatalist.append(el('option', { value: v.name }));
  }
  function refreshRefDatalist() {
    while (refDatalist.firstChild) refDatalist.removeChild(refDatalist.firstChild);
    for (const r of allReferences) refDatalist.append(el('option', { value: r.name }));
  }
  function varietyIdByLowerName() {
    return new Map(allVarieties.map((v) => [v.name.toLowerCase(), v.id]));
  }
  function refByLowerName() {
    return new Map(allReferences.map((r) => [r.name.toLowerCase(), r]));
  }

  const rows = [];
  const tbody = el('tbody', {});

  function addRow(prefill) {
    const row = createBulkRow({
      varietyDatalistId,
      refDatalistId,
      lookupRef: (name) => refByLowerName().get((name || '').toLowerCase()) || null,
      onRemove: () => removeRow(row),
    }, prefill);
    rows.push(row);
    tbody.append(row.tr);
    refreshIndices();
    updateSubmitLabel();
    return row;
  }

  function removeRow(row) {
    if (rows.length === 1) {
      toast('Debe haber al menos un pedido', 'warning');
      return;
    }
    tbody.removeChild(row.tr);
    const idx = rows.indexOf(row);
    if (idx >= 0) rows.splice(idx, 1);
    refreshIndices();
    updateSubmitLabel();
  }

  function refreshIndices() {
    rows.forEach((r, i) => r.setIndex(i, rows.length));
  }

  const submitBtn = el('button', {
    type: 'submit',
    class: 'ctrm-btn ctrm-btn-yellow uppercase tracking-eyebrow text-[11px] py-3 px-6',
  }, ['Crear pedido']);

  function updateSubmitLabel() {
    submitBtn.textContent = rows.length === 1 ? 'Crear pedido' : `Crear ${rows.length} pedidos`;
  }

  const addRowBtn = el('button', {
    type: 'button',
    class: 'ctrm-btn ctrm-btn-soft text-[12px]',
    onClick: () => {
      const row = addRow();
      row.focus();
    },
  }, ['+ Agregar fila']);

  const duplicateBtn = el('button', {
    type: 'button',
    class: 'ctrm-btn ctrm-btn-ghost text-[12px]',
    title: 'Duplica la última fila (útil para baches similares con kg/fecha distintos)',
    onClick: () => {
      const last = rows[rows.length - 1];
      const row = addRow(last.snapshot());
      row.focus();
    },
  }, ['⎘ Duplicar última']);

  const COLS = [
    { key: 'idx',       label: '#',           cls: 'w-10 text-center' },
    { key: 'ref',       label: 'Referencia *', cls: 'min-w-[160px]' },
    { key: 'varieties', label: 'Variedades',  cls: 'min-w-[180px]' },
    { key: 'kg',        label: 'kg verde *',  cls: 'w-28 text-right' },
    { key: 'date',      label: 'Fecha *',     cls: 'w-36' },
    { key: 'aspect',    label: 'Aspecto *',   cls: 'min-w-[140px]' },
    { key: 'process',   label: 'Proceso *',   cls: 'min-w-[110px]' },
    { key: 'ferm',      label: 'Ferm. (h)',   cls: 'w-20 text-right' },
    { key: 'client',    label: 'Cliente',     cls: 'min-w-[140px]' },
    { key: 'orderType', label: 'Tipo',        cls: 'min-w-[110px]' },
    { key: 'regions',   label: 'Regiones',    cls: 'min-w-[180px]' },
    { key: 'contract',  label: 'Contrato',    cls: 'min-w-[120px]' },
    { key: 'intensity', label: 'Intensidad',  cls: 'min-w-[110px]' },
    { key: 'comments',  label: 'Comentarios', cls: 'min-w-[180px]' },
    { key: 'remove',    label: '',            cls: 'w-10 text-center' },
  ];

  const table = el('table', { class: 'w-full text-[12px] bulk-table' }, [
    el('thead', {}, [
      el('tr', {}, COLS.map((c) =>
        el('th', { class: `${c.cls} px-2 py-2 text-left font-display text-[11px] uppercase tracking-eyebrow text-ink-500` }, [c.label]))),
    ]),
    tbody,
  ]);

  const tableWrap = el('div', { class: 'ctrm-card overflow-x-auto' }, [table]);

  const form = el('form', {
    class: 'space-y-3',
    onSubmit: async (e) => {
      e.preventDefault();
      const allErrors = [];
      const partials = [];   // [{ payloadSkeleton, rawVarietyNames }]
      rows.forEach((r, i) => {
        const result = r.validate();
        if (result.errors.length > 0) allErrors.push({ index: i, errors: result.errors });
        else partials.push(result);
      });
      if (allErrors.length > 0) {
        const first = allErrors[0];
        toast(`Fila ${first.index + 1}: ${first.errors[0]}`, 'warning');
        rows[first.index].focus();
        return;
      }

      // ── Resolver referencias nuevas ──
      let refLookup = refByLowerName();
      const newRefs = new Map();  // lowercase → { name, process_type, fermentation_hours }
      for (const p of partials) {
        const raw = p.refRawName.trim();
        if (!raw) continue;
        const key = raw.toLowerCase();
        if (refLookup.has(key)) continue;
        if (!newRefs.has(key)) {
          newRefs.set(key, {
            name: raw,
            process_type: p.payloadSkeleton.process_type || null,
            fermentation_hours: p.payloadSkeleton.fermentation_hours,
          });
        }
      }

      // ── Resolver variedades nuevas ──
      let varietyLookup = varietyIdByLowerName();
      const newVarieties = new Map();  // lowercase → original casing
      for (const p of partials) {
        for (const name of p.rawVarietyNames) {
          if (!varietyLookup.has(name.toLowerCase())) newVarieties.set(name.toLowerCase(), name);
        }
      }

      // ── Confirmar (un solo modal si hay items nuevos) ──
      if (newRefs.size > 0 || newVarieties.size > 0) {
        const parts = [];
        if (newRefs.size > 0) {
          parts.push(`Referencias (${newRefs.size}):\n${[...newRefs.values()]
            .map((r) => `• ${r.name}${r.process_type ? ` (${r.process_type}${r.fermentation_hours != null ? `, ${r.fermentation_hours}h` : ''})` : ''}`)
            .join('\n')}`);
        }
        if (newVarieties.size > 0) {
          parts.push(`Variedades (${newVarieties.size}):\n${[...newVarieties.values()]
            .map((n) => `• ${n}`).join('\n')}`);
        }
        const ok = await confirmModal(
          `Se crearán items nuevos antes de guardar los pedidos:\n\n${parts.join('\n\n')}\n\n¿Continuar?`,
          { title: 'Items nuevos', confirmText: 'Crear y continuar', cancelText: 'Volver' },
        );
        if (!ok) return;

        submitBtn.disabled = true;
        try {
          if (newRefs.size > 0) {
            submitBtn.textContent = 'Creando referencias...';
            for (const r of newRefs.values()) {
              const resp = await api.referenceSave({
                name: r.name,
                process_type: r.process_type,
                fermentation_hours: r.fermentation_hours,
              });
              const created = resp && resp.reference;
              if (created && !allReferences.some((x) => x.id === created.id)) {
                allReferences = [...allReferences, created].sort((a, b) => a.name.localeCompare(b.name));
              }
            }
            refreshRefDatalist();
            refLookup = refByLowerName();
          }
          if (newVarieties.size > 0) {
            submitBtn.textContent = 'Creando variedades...';
            for (const name of newVarieties.values()) {
              const resp = await api.varietyAdd(name);
              const created = resp && resp.variety;
              if (created && !allVarieties.some((v) => v.id === created.id)) {
                allVarieties = [...allVarieties, created].sort((a, b) => a.name.localeCompare(b.name));
              }
            }
            refreshVarietyDatalist();
            varietyLookup = varietyIdByLowerName();
          }
        } catch (e) {
          toast(e.message || 'Error creando items nuevos', 'error');
          submitBtn.disabled = false;
          updateSubmitLabel();
          return;
        }
      }

      // ── Construir payloads finales ──
      const orders = partials.map((p) => {
        const ref = refLookup.get(p.refRawName.toLowerCase());
        return {
          ...p.payloadSkeleton,
          reference_id: ref ? ref.id : null,
          variety_ids: p.rawVarietyNames.map((n) => varietyLookup.get(n.toLowerCase())).filter(Boolean),
        };
      });

      await trySubmit(orders, false);
    },
  }, [
    el('div', { class: 'flex flex-wrap items-center gap-2' }, [
      addRowBtn,
      duplicateBtn,
      el('p', { class: 'text-[11px] text-ink-500 ml-auto' }, [
        'Si escribes una referencia o variedad nueva, se pedirá confirmación antes de crearla.',
      ]),
    ]),
    tableWrap,
    el('div', { class: 'pt-3 flex flex-col sm:flex-row sm:justify-end gap-2 border-t border-sand' }, [
      el('button', {
        type: 'button',
        class: 'ctrm-btn ctrm-btn-ghost uppercase tracking-eyebrow text-[11px] py-3 px-6',
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
        const lines = offending.map((row) => `• Fila ${row.index + 1}: ${row.days} día(s)`).join('\n');
        const ok = await confirmModal(
          `${offending.length} pedido(s) con entrega a menos de 15 días:\n\n${lines}\n\n¿Ya se confirmó con la planta de producción?`,
          { title: '⚠️ Plazo corto', confirmText: 'Confirmado, crear', cancelText: 'Volver', danger: true },
        );
        if (ok) { await trySubmit(orders, true); return; }
      } else if (e.code === 'VALIDATION_ERROR' && e.detail && e.detail.row_errors) {
        const first = e.detail.row_errors[0];
        toast(`Fila ${first.index + 1}: ${first.errors[0]}`, 'error');
        if (rows[first.index]) rows[first.index].focus();
      } else if (e.code === 'INVALID_REFERENCE' && e.detail && e.detail.row_errors) {
        const first = e.detail.row_errors[0];
        toast(`Fila ${first.index + 1}: referencia inválida`, 'error');
        if (rows[first.index]) rows[first.index].focus();
      } else {
        toast(e.message || 'Error al crear pedidos', 'error');
      }
    } finally {
      submitBtn.disabled = false;
      updateSubmitLabel();
    }
  }

  // Empezar con 3 filas — suficiente para el caso típico, agrega más con +
  addRow(); addRow(); addRow();

  return chrome(el('div', {}, [
    pageTitle('Crear varios pedidos', 'Forest → El Vergel · entrada rápida en tabla'),
    form,
  ]));
}

// ─── Fila de tabla ────────────────────────────────────────────────────
function createBulkRow({ varietyDatalistId, refDatalistId, lookupRef, onRemove }, prefill) {
  const cellCls = 'px-2 py-1.5 align-top';

  const idxLabel = el('span', { class: 'text-ink-500 font-mono text-[11px]', text: '1' });

  const refInput = el('input', {
    type: 'text', class: 'ctrm-input w-full text-[12px]',
    placeholder: 'Nombre de referencia',
    title: 'Existente del catálogo, o nueva (se crea al guardar).',
    list: refDatalistId,
    autocomplete: 'off',
  });

  const varietyInput = el('input', {
    type: 'text', class: 'ctrm-input w-full text-[12px]',
    placeholder: 'castillo, caturra',
    title: 'Nombres separados por coma. Si una no existe se crea al guardar.',
    list: varietyDatalistId,
  });

  const kgInput = el('input', {
    type: 'number', min: '0', step: '0.01',
    class: 'ctrm-input mono w-full text-[12px] text-right',
    placeholder: '0',
  });
  const dateInput = el('input', { type: 'date', class: 'ctrm-input w-full text-[12px]' });
  const aspectSelect = el('select', { class: 'ctrm-select w-full text-[12px]' }, [
    el('option', { value: '' }, ['—']),
    ...PHYSICAL_ASPECTS.map((a) => el('option', { value: a }, [a])),
  ]);
  const processSelect = el('select', { class: 'ctrm-select w-full text-[12px]' }, [
    el('option', { value: '' }, ['—']),
    ...PROCESS_TYPES.map((p) => el('option', { value: p }, [p])),
  ]);
  const fermInput = el('input', {
    type: 'number', min: '0', step: '0.5',
    class: 'ctrm-input mono w-full text-[12px] text-right',
    placeholder: '—',
  });
  const clientInput = el('input', {
    type: 'text', class: 'ctrm-input w-full text-[12px]',
    autocomplete: 'off', placeholder: '—',
  });
  const orderTypeSelect = el('select', { class: 'ctrm-select w-full text-[12px]' }, [
    el('option', { value: '' }, ['—']),
    ...ORDER_TYPES.map((t) => el('option', { value: t }, [t])),
  ]);

  // Regiones: chips compactas tipo toggle.
  const regionChips = REGIONS.map((r) => {
    const btn = el('button', {
      type: 'button',
      class: 'px-1.5 py-0.5 rounded border border-sand text-[10px] font-display font-semibold text-ink-500 bg-white',
      onClick: () => {
        const on = btn.getAttribute('data-on') === 'true';
        btn.setAttribute('data-on', on ? 'false' : 'true');
        btn.style.background = on ? '' : '#1a3a5c';
        btn.style.color      = on ? '' : 'white';
        btn.style.borderColor = on ? '' : '#1a3a5c';
      },
    }, [r]);
    btn.setAttribute('data-on', 'false');
    btn.setAttribute('data-region', r);
    return btn;
  });
  const regionsCell = el('div', { class: 'flex flex-wrap gap-1' }, regionChips);

  const contractInput = el('input', {
    type: 'text', class: 'ctrm-input mono w-full text-[12px]',
    autocomplete: 'off', placeholder: '—',
  });
  const intensitySelect = el('select', { class: 'ctrm-select w-full text-[12px]' }, [
    el('option', { value: '' }, ['—']),
    el('option', { value: 'media' },    ['Media']),
    el('option', { value: 'alta' },     ['Alta']),
    el('option', { value: 'muy_alta' }, ['Muy alta']),
  ]);
  const commentsInput = el('input', {
    type: 'text', class: 'ctrm-input w-full text-[12px]',
    placeholder: '—',
  });

  // Auto-fill proceso + fermentación cuando el nombre coincide con una
  // referencia existente. Si el usuario escribe un nombre nuevo, no
  // toca proceso/ferm.
  refInput.addEventListener('change', () => {
    const ref = lookupRef(refInput.value);
    if (!ref) return;
    if (ref.process_type) processSelect.value = ref.process_type;
    if (ref.fermentation_hours != null && fermInput.value === '') fermInput.value = String(ref.fermentation_hours);
  });
  refInput.addEventListener('input', () => {
    // El "input" event dispara cuando el usuario selecciona una opcion
    // del datalist (al menos en Chrome/Firefox), asi cubrimos ese caso.
    const ref = lookupRef(refInput.value);
    if (!ref) return;
    if (ref.process_type) processSelect.value = ref.process_type;
    if (ref.fermentation_hours != null && fermInput.value === '') fermInput.value = String(ref.fermentation_hours);
  });

  // kg hint inline (al lado de la celda, muy corto)
  const kgHint = el('span', { class: 'text-[10px] text-ink-300 ml-1' });
  kgInput.addEventListener('input', () => {
    const v = Number(kgInput.value || 0);
    kgHint.textContent = v > 0 ? `≈${fmtKg(v * CHERRY_PER_GREEN)} cereza` : '';
  });

  const removeBtn = el('button', {
    type: 'button',
    class: 'ctrm-btn ctrm-btn-ghost ctrm-btn-xs',
    title: 'Quitar fila',
    onClick: () => onRemove && onRemove(),
  }, ['✕']);

  const tr = el('tr', { class: 'border-t border-sand align-top' }, [
    el('td', { class: `${cellCls} text-center` }, [idxLabel]),
    el('td', { class: cellCls }, [refInput]),
    el('td', { class: cellCls }, [varietyInput]),
    el('td', { class: cellCls }, [kgInput, kgHint]),
    el('td', { class: cellCls }, [dateInput]),
    el('td', { class: cellCls }, [aspectSelect]),
    el('td', { class: cellCls }, [processSelect]),
    el('td', { class: cellCls }, [fermInput]),
    el('td', { class: cellCls }, [clientInput]),
    el('td', { class: cellCls }, [orderTypeSelect]),
    el('td', { class: cellCls }, [regionsCell]),
    el('td', { class: cellCls }, [contractInput]),
    el('td', { class: cellCls }, [intensitySelect]),
    el('td', { class: cellCls }, [commentsInput]),
    el('td', { class: `${cellCls} text-center` }, [removeBtn]),
  ]);

  if (prefill) applyPrefill(prefill);

  function applyPrefill(p) {
    if (p.reference_name) refInput.value = p.reference_name;
    if (p.variety_names) varietyInput.value = p.variety_names;
    if (p.kg) kgInput.value = p.kg;
    if (p.date) dateInput.value = p.date;
    if (p.aspect) aspectSelect.value = p.aspect;
    if (p.process) processSelect.value = p.process;
    if (p.ferm != null) fermInput.value = p.ferm;
    if (p.client) clientInput.value = p.client;
    if (p.orderType) orderTypeSelect.value = p.orderType;
    if (p.contract) contractInput.value = p.contract;
    if (p.intensity) intensitySelect.value = p.intensity;
    if (p.comments) commentsInput.value = p.comments;
    if (Array.isArray(p.regions)) {
      for (const btn of regionChips) {
        if (p.regions.includes(btn.getAttribute('data-region'))) btn.click();
      }
    }
  }

  function snapshot() {
    return {
      reference_name: refInput.value,
      variety_names: varietyInput.value,
      kg: kgInput.value,
      date: dateInput.value,
      aspect: aspectSelect.value,
      process: processSelect.value,
      ferm: fermInput.value,
      client: clientInput.value,
      orderType: orderTypeSelect.value,
      contract: contractInput.value,
      intensity: intensitySelect.value,
      comments: commentsInput.value,
      regions: regionChips.filter((b) => b.getAttribute('data-on') === 'true')
        .map((b) => b.getAttribute('data-region')),
    };
  }

  function setIndex(i, _total) {
    idxLabel.textContent = String(i + 1);
  }

  function validate() {
    const errors = [];
    const refRawName = refInput.value.trim();
    if (!refRawName) errors.push('Escribe el nombre de una referencia');
    const kg = Number(kgInput.value);
    if (!Number.isFinite(kg) || kg <= 0) errors.push('Ingresa una cantidad mayor a 0');
    if (!dateInput.value) errors.push('Selecciona una fecha de entrega');
    if (!aspectSelect.value) errors.push('Selecciona aspecto físico');
    if (!processSelect.value) errors.push('Selecciona proceso');

    if (errors.length > 0) return { errors, payloadSkeleton: null, rawVarietyNames: [], refRawName: '' };

    const rawVarietyNames = varietyInput.value.split(',').map((s) => s.trim()).filter(Boolean);
    const selectedRegions = regionChips.filter((b) => b.getAttribute('data-on') === 'true')
      .map((b) => b.getAttribute('data-region'));

    const payloadSkeleton = {
      kg_green_required: kg,
      max_delivery_date: dateInput.value,
      physical_aspect: aspectSelect.value,
      process_type: processSelect.value,
      fermentation_hours: fermInput.value === '' ? null : Number(fermInput.value),
      comments: commentsInput.value || null,
      order_type: orderTypeSelect.value || null,
      client_name: clientInput.value.trim() || null,
      regions: selectedRegions.length > 0 ? selectedRegions : null,
      contract_code: contractInput.value.trim() || null,
      intensity: intensitySelect.value || null,
    };
    return { errors: [], payloadSkeleton, rawVarietyNames, refRawName };
  }

  function focus() {
    tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => refInput.focus(), 150);
  }

  return { tr, validate, setIndex, focus, snapshot };
}
