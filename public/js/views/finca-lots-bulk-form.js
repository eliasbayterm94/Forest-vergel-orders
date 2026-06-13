// Bulk lot entry — table layout para crear varios baches a la vez.
// Mirrors el patrón de forest-demand-bulk-form: cada fila es una TR
// con inputs/selects nativos para TAB-navegacion rapida. Referencias,
// variedades e infusiones se pueden crear sobre la marcha (con
// confirmacion en un solo modal al guardar).

import { el } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { confirmModal } from '../ui/modal.js';
import { fmtKg } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { createMultiCombobox } from '../ui/combobox.js';
import { navigate } from '../router.js';

const PROCESS_TYPES = ['Natural', 'Honey', 'Lavado'];
const STAGE_OPTIONS = [
  { value: 'cereza',     label: 'Cereza',      divisor: 7.65,  inputLabel: 'kg cereza' },
  { value: 'despulpado', label: 'Despulpado',  divisor: 4.20,  inputLabel: 'kg despulpado' },
  { value: 'seco',       label: 'Seco',        divisor: 1.34,  inputLabel: 'kg seco' },
];

export async function fincaLotsBulkFormView() {
  const [refsRes, varsRes, infRes, tanksRes] = await Promise.all([
    api.references(),
    api.varieties(),
    api.infusions().catch(() => ({ infusions: [] })),
    api.fermentationTanksList({}).catch(() => ({ fermentation_tanks: [] })),
  ]);
  let allReferences = refsRes.references || [];
  let allVarieties  = varsRes.varieties  || [];
  let allInfusions  = (infRes && infRes.infusions) || [];
  let allTanks      = (tanksRes && tanksRes.fermentation_tanks) || [];

  // Datalists compartidos
  const refDatalistId      = 'finca-bulk-ref-list';
  const varietyDatalistId  = 'finca-bulk-variety-list';
  const infusionDatalistId = 'finca-bulk-infusion-list';
  const refDatalist      = el('datalist', { id: refDatalistId },      allReferences.map((r) => el('option', { value: r.name })));
  const varietyDatalist  = el('datalist', { id: varietyDatalistId },  allVarieties.map((v)  => el('option', { value: v.name })));
  const infusionDatalist = el('datalist', { id: infusionDatalistId }, allInfusions.map((i)  => el('option', { value: i.name })));
  document.body.append(refDatalist, varietyDatalist, infusionDatalist);

  function refreshDatalist(node, list) {
    while (node.firstChild) node.removeChild(node.firstChild);
    for (const x of list) node.append(el('option', { value: x.name }));
  }
  const refByLowerName      = () => new Map(allReferences.map((r) => [r.name.toLowerCase(), r]));
  const varietyIdByLowerName = () => new Map(allVarieties.map((v) => [v.name.toLowerCase(), v.id]));
  const infusionByLowerName = () => new Map(allInfusions.map((i) => [i.name.toLowerCase(), i]));

  const rows = [];
  const tbody = el('tbody', {});

  function addRow(prefill) {
    const row = createBulkRow({
      refDatalistId,
      varietyDatalistId,
      infusionDatalistId,
      allTanks,
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
    if (rows.length === 1) { toast('Debe haber al menos un bache', 'warning'); return; }
    tbody.removeChild(row.tr);
    const idx = rows.indexOf(row);
    if (idx >= 0) rows.splice(idx, 1);
    refreshIndices();
    updateSubmitLabel();
  }
  function refreshIndices() {
    rows.forEach((r, i) => r.setIndex(i));
  }

  const submitBtn = el('button', {
    type: 'submit',
    class: 'ctrm-btn ctrm-btn-yellow uppercase tracking-eyebrow text-[11px] py-3 px-6',
  }, ['Crear bache']);
  function updateSubmitLabel() {
    submitBtn.textContent = rows.length === 1 ? 'Crear bache' : `Crear ${rows.length} baches`;
  }

  const addRowBtn = el('button', {
    type: 'button',
    class: 'ctrm-btn ctrm-btn-soft text-[12px]',
    onClick: () => { const r = addRow(); r.focus(); },
  }, ['+ Agregar fila']);
  const duplicateBtn = el('button', {
    type: 'button',
    class: 'ctrm-btn ctrm-btn-ghost text-[12px]',
    title: 'Duplica la última fila (útil para baches similares)',
    onClick: () => {
      const last = rows[rows.length - 1];
      const r = addRow(last.snapshot());
      r.focus();
    },
  }, ['⎘ Duplicar última']);

  const COLS = [
    { label: '#',          cls: 'w-10 text-center' },
    { label: 'Bache *',    cls: 'min-w-[110px]' },
    { label: 'Referencia', cls: 'min-w-[160px]' },
    { label: 'Proceso *',  cls: 'min-w-[110px]' },
    { label: 'Etapa *',    cls: 'min-w-[120px]' },
    { label: 'Kg entrada *', cls: 'w-28 text-right' },
    { label: 'Inicio *',   cls: 'w-36' },
    { label: 'Variedades *', cls: 'min-w-[180px]' },
    { label: 'Tanques',    cls: 'min-w-[150px]' },
    { label: 'Ferm. (h)',  cls: 'w-20 text-right' },
    { label: 'Infusión',   cls: 'min-w-[130px]' },
    { label: '%',          cls: 'w-16 text-right' },
    { label: 'Notas',      cls: 'min-w-[160px]' },
    { label: '',           cls: 'w-10 text-center' },
  ];

  const table = el('table', { class: 'w-full text-[12px] bulk-table' }, [
    el('thead', {}, [el('tr', {}, COLS.map((c) =>
      el('th', { class: `${c.cls} px-2 py-2 text-left font-display text-[11px] uppercase tracking-eyebrow text-ink-500` }, [c.label])))]),
    tbody,
  ]);
  const tableWrap = el('div', { class: 'ctrm-card overflow-x-auto' }, [table]);

  const form = el('form', {
    class: 'space-y-3',
    onSubmit: async (e) => {
      e.preventDefault();
      const allErrors = [];
      const partials = [];
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

      // Detectar items nuevos (refs, variedades, infusiones).
      let refLookup     = refByLowerName();
      let varietyLookup = varietyIdByLowerName();
      let infusionLookup = infusionByLowerName();

      const newRefs = new Map();        // lowercase → { name, process_type, fermentation_hours }
      const newVarieties = new Map();   // lowercase → original
      const newInfusions = new Map();   // lowercase → original

      for (const p of partials) {
        const refKey = p.refRawName.toLowerCase();
        if (p.refRawName && !refLookup.has(refKey) && !newRefs.has(refKey)) {
          newRefs.set(refKey, {
            name: p.refRawName,
            process_type: p.payloadSkeleton.process_type || null,
            fermentation_hours: p.payloadSkeleton.fermentation_hours,
          });
        }
        for (const name of p.rawVarietyNames) {
          if (!varietyLookup.has(name.toLowerCase())) newVarieties.set(name.toLowerCase(), name);
        }
        if (p.infusionRawName) {
          const k = p.infusionRawName.toLowerCase();
          if (!infusionLookup.has(k) && !newInfusions.has(k)) newInfusions.set(k, p.infusionRawName);
        }
      }

      if (newRefs.size + newVarieties.size + newInfusions.size > 0) {
        const parts = [];
        if (newRefs.size > 0) {
          parts.push(`Referencias (${newRefs.size}):\n${[...newRefs.values()]
            .map((r) => `• ${r.name}${r.process_type ? ` (${r.process_type}${r.fermentation_hours != null ? `, ${r.fermentation_hours}h` : ''})` : ''}`)
            .join('\n')}`);
        }
        if (newVarieties.size > 0) {
          parts.push(`Variedades (${newVarieties.size}):\n${[...newVarieties.values()].map((n) => `• ${n}`).join('\n')}`);
        }
        if (newInfusions.size > 0) {
          parts.push(`Infusiones (${newInfusions.size}):\n${[...newInfusions.values()].map((n) => `• ${n}`).join('\n')}`);
        }
        const ok = await confirmModal(
          `Se crearán items nuevos antes de guardar los baches:\n\n${parts.join('\n\n')}\n\n¿Continuar?`,
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
            refreshDatalist(refDatalist, allReferences);
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
            refreshDatalist(varietyDatalist, allVarieties);
            varietyLookup = varietyIdByLowerName();
          }
          if (newInfusions.size > 0) {
            submitBtn.textContent = 'Creando infusiones...';
            for (const name of newInfusions.values()) {
              const resp = await api.infusionAdd(name);
              const created = resp && resp.infusion;
              if (created && !allInfusions.some((i) => i.id === created.id)) {
                allInfusions = [...allInfusions, created].sort((a, b) => a.name.localeCompare(b.name));
              }
            }
            refreshDatalist(infusionDatalist, allInfusions);
            infusionLookup = infusionByLowerName();
          }
        } catch (e) {
          toast(e.message || 'Error creando items nuevos', 'error');
          submitBtn.disabled = false;
          updateSubmitLabel();
          return;
        }
      }

      // Payloads finales
      const lots = partials.map((p) => {
        const ref = refLookup.get(p.refRawName.toLowerCase());
        const infusion = p.infusionRawName ? infusionLookup.get(p.infusionRawName.toLowerCase()) : null;
        return {
          ...p.payloadSkeleton,
          reference_id: ref ? ref.id : null,
          variety_ids: p.rawVarietyNames.map((n) => varietyLookup.get(n.toLowerCase())).filter(Boolean),
          infusion_id: infusion ? infusion.id : null,
          infusion_pct: p.payloadSkeleton.infusion_pct,
        };
      });

      await trySubmit(lots);
    },
  }, [
    el('div', { class: 'flex flex-wrap items-center gap-2' }, [
      addRowBtn,
      duplicateBtn,
      el('p', { class: 'text-[11px] text-ink-500 ml-auto' }, [
        'Referencias / variedades / infusiones nuevas se crean al guardar (se pedirá confirmación).',
      ]),
    ]),
    tableWrap,
    el('div', { class: 'pt-3 flex flex-col sm:flex-row sm:justify-end gap-2 border-t border-sand' }, [
      el('button', {
        type: 'button',
        class: 'ctrm-btn ctrm-btn-ghost uppercase tracking-eyebrow text-[11px] py-3 px-6',
        onClick: () => navigate('/finca/lots'),
      }, ['Cancelar']),
      submitBtn,
    ]),
  ]);

  async function trySubmit(lots) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Enviando...';
    try {
      const r = await api.lotCreateBulk({ lots });
      const n = (r.lots || []).length;
      toast(n === 1 ? `Bache ${r.lots[0].bache_code} creado` : `${n} baches creados`, 'success');
      navigate('/finca/lots');
    } catch (e) {
      if (e.code === 'VALIDATION_ERROR' && e.detail && e.detail.row_errors) {
        const first = e.detail.row_errors[0];
        toast(`Fila ${first.index + 1}: ${first.errors[0]}`, 'error');
        if (rows[first.index]) rows[first.index].focus();
      } else if (e.code === 'BACHE_CODE_TAKEN' && e.detail && e.detail.row_errors) {
        const first = e.detail.row_errors[0];
        toast(`Fila ${first.index + 1}: bache_code ya existe`, 'error');
        if (rows[first.index]) rows[first.index].focus();
      } else if (e.code === 'INVALID_REFERENCE' && e.detail && e.detail.row_errors) {
        const first = e.detail.row_errors[0];
        toast(`Fila ${first.index + 1}: referencia inválida`, 'error');
        if (rows[first.index]) rows[first.index].focus();
      } else {
        toast(e.message || 'Error al crear baches', 'error');
      }
    } finally {
      submitBtn.disabled = false;
      updateSubmitLabel();
    }
  }

  addRow(); addRow(); addRow();

  return chrome(el('div', {}, [
    pageTitle('Crear varios baches', 'El Vergel · entrada rápida en tabla'),
    form,
  ]));
}

// ─── Fila ──────────────────────────────────────────────────────────────
function createBulkRow({ refDatalistId, varietyDatalistId, infusionDatalistId, allTanks, lookupRef, onRemove }, prefill) {
  const cellCls = 'px-2 py-1.5 align-top';

  const idxLabel = el('span', { class: 'text-ink-500 font-mono text-[11px]', text: '1' });

  const bacheInput = el('input', {
    type: 'text', class: 'ctrm-input mono w-full text-[12px]',
    placeholder: 'B-XXX', autocomplete: 'off',
  });
  const refInput = el('input', {
    type: 'text', class: 'ctrm-input w-full text-[12px]',
    placeholder: 'Nombre de referencia', autocomplete: 'off',
    list: refDatalistId,
  });
  const processSelect = el('select', { class: 'ctrm-select w-full text-[12px]' }, [
    el('option', { value: '' }, ['—']),
    ...PROCESS_TYPES.map((p) => el('option', { value: p }, [p])),
  ]);
  const stageSelect = el('select', { class: 'ctrm-select w-full text-[12px]' }, [
    el('option', { value: '' }, ['—']),
    ...STAGE_OPTIONS.map((s) => el('option', { value: s.value }, [s.label])),
  ]);
  const kgInput = el('input', {
    type: 'number', min: '0', step: '0.01',
    class: 'ctrm-input mono w-full text-[12px] text-right',
    placeholder: '0',
  });
  const greenHint = el('span', { class: 'text-[10px] text-ink-300 ml-1' });
  const dateInput = el('input', { type: 'date', class: 'ctrm-input w-full text-[12px]' });
  const varietyInput = el('input', {
    type: 'text', class: 'ctrm-input w-full text-[12px]',
    placeholder: 'castillo, caturra',
    title: 'Nombres separados por coma',
    list: varietyDatalistId,
  });
  const tanksCombo = createMultiCombobox({
    placeholder: (allTanks || []).length > 0 ? 'Tanques…' : '— Sin tanques (admin) —',
    items: allTanks || [],
  });
  // Wrapper compacto para que respete el ancho de la celda
  const tanksCell = el('div', { class: 'text-[11px]' }, [tanksCombo.el]);
  const fermInput = el('input', {
    type: 'number', min: '0', step: '0.5',
    class: 'ctrm-input mono w-full text-[12px] text-right',
    placeholder: '—',
  });
  const infusionInput = el('input', {
    type: 'text', class: 'ctrm-input w-full text-[12px]',
    placeholder: '—', autocomplete: 'off',
    list: infusionDatalistId,
  });
  const infusionPctInput = el('input', {
    type: 'number', min: '0', max: '100', step: '0.5',
    class: 'ctrm-input mono w-full text-[12px] text-right',
    placeholder: '%',
  });
  const notesInput = el('input', {
    type: 'text', class: 'ctrm-input w-full text-[12px]', placeholder: '—',
  });

  function refreshGreenHint() {
    const stage = STAGE_OPTIONS.find((s) => s.value === stageSelect.value);
    const kg = Number(kgInput.value || 0);
    if (!stage || !(kg > 0)) { greenHint.textContent = ''; return; }
    const green = kg / stage.divisor;
    greenHint.textContent = `≈${fmtKg(green)} verde`;
  }
  kgInput.addEventListener('input',  refreshGreenHint);
  stageSelect.addEventListener('change', refreshGreenHint);

  function onRefChange() {
    const ref = lookupRef(refInput.value);
    if (!ref) return;
    if (ref.process_type) processSelect.value = ref.process_type;
    if (ref.fermentation_hours != null && fermInput.value === '') fermInput.value = String(ref.fermentation_hours);
  }
  refInput.addEventListener('change', onRefChange);
  refInput.addEventListener('input',  onRefChange);

  const removeBtn = el('button', {
    type: 'button',
    class: 'ctrm-btn ctrm-btn-ghost ctrm-btn-xs',
    title: 'Quitar fila',
    onClick: () => onRemove && onRemove(),
  }, ['✕']);

  const tr = el('tr', { class: 'border-t border-sand align-top' }, [
    el('td', { class: `${cellCls} text-center` }, [idxLabel]),
    el('td', { class: cellCls }, [bacheInput]),
    el('td', { class: cellCls }, [refInput]),
    el('td', { class: cellCls }, [processSelect]),
    el('td', { class: cellCls }, [stageSelect]),
    el('td', { class: cellCls }, [kgInput, greenHint]),
    el('td', { class: cellCls }, [dateInput]),
    el('td', { class: cellCls }, [varietyInput]),
    el('td', { class: cellCls }, [tanksCell]),
    el('td', { class: cellCls }, [fermInput]),
    el('td', { class: cellCls }, [infusionInput]),
    el('td', { class: cellCls }, [infusionPctInput]),
    el('td', { class: cellCls }, [notesInput]),
    el('td', { class: `${cellCls} text-center` }, [removeBtn]),
  ]);

  if (prefill) applyPrefill(prefill);

  function applyPrefill(p) {
    if (p.bache_code)  bacheInput.value  = p.bache_code;
    if (p.ref_name)    refInput.value    = p.ref_name;
    if (p.process)     processSelect.value = p.process;
    if (p.stage)       stageSelect.value   = p.stage;
    if (p.kg != null)  kgInput.value     = p.kg;
    if (p.date)        dateInput.value   = p.date;
    if (p.varieties)   varietyInput.value = p.varieties;
    if (Array.isArray(p.tanks) && p.tanks.length > 0) {
      const byName = new Map((allTanks || []).map((t) => [t.name, t]));
      const matched = p.tanks.map((n) => byName.get(n)).filter(Boolean);
      tanksCombo.setValues(matched);
    }
    if (p.ferm != null) fermInput.value  = p.ferm;
    if (p.infusion)    infusionInput.value = p.infusion;
    if (p.infusion_pct != null) infusionPctInput.value = p.infusion_pct;
    if (p.notes)       notesInput.value  = p.notes;
    refreshGreenHint();
  }

  function snapshot() {
    return {
      bache_code: '',  // se debe escribir uno nuevo
      ref_name:   refInput.value,
      process:    processSelect.value,
      stage:      stageSelect.value,
      kg:         kgInput.value,
      date:       dateInput.value,
      varieties:  varietyInput.value,
      tanks:      tanksCombo.getValues().map((t) => t.name),
      ferm:       fermInput.value,
      infusion:   infusionInput.value,
      infusion_pct: infusionPctInput.value,
      notes:      notesInput.value,
    };
  }

  function setIndex(i) { idxLabel.textContent = String(i + 1); }

  function validate() {
    const errors = [];
    const bache = bacheInput.value.trim();
    const refRawName = refInput.value.trim();
    const kg = Number(kgInput.value);
    const infRaw = infusionInput.value.trim();
    const infPct = infusionPctInput.value === '' ? null : Number(infusionPctInput.value);

    if (!bache) errors.push('Falta bache_code');
    if (!processSelect.value) errors.push('Falta proceso');
    if (!stageSelect.value) errors.push('Falta etapa');
    if (!Number.isFinite(kg) || kg <= 0) errors.push('Kg entrada debe ser > 0');
    if (!dateInput.value) errors.push('Falta fecha de inicio');
    const rawVarietiesPre = varietyInput.value.split(',').map((s) => s.trim()).filter(Boolean);
    if (rawVarietiesPre.length === 0) errors.push('Falta al menos una variedad');

    // Infusión: ambos o ninguno
    if ((infRaw && infPct == null) || (!infRaw && infPct != null)) {
      errors.push('Infusión: necesita nombre y % ambos');
    }
    if (infPct != null && (!Number.isFinite(infPct) || infPct <= 0 || infPct > 100)) {
      errors.push('Infusión %: 0 < % ≤ 100');
    }

    if (errors.length > 0) {
      return { errors, payloadSkeleton: null, refRawName: '', rawVarietyNames: [], infusionRawName: '' };
    }

    const rawVarietyNames = varietyInput.value.split(',').map((s) => s.trim()).filter(Boolean);
    const rawTankNames = tanksCombo.getValues().map((t) => t.name);
    const payloadSkeleton = {
      bache_code: bache,
      process_type: processSelect.value,
      processing_stage: stageSelect.value,
      kg_input_amount: kg,
      start_date: dateInput.value,
      fermentation_hours: fermInput.value === '' ? null : Number(fermInput.value),
      fermentation_tanks: rawTankNames,
      notes: notesInput.value || null,
      infusion_pct: infRaw ? infPct : null,
    };

    return { errors: [], payloadSkeleton, refRawName, rawVarietyNames, infusionRawName: infRaw };
  }

  function focus() {
    tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => bacheInput.focus(), 150);
  }

  return { tr, validate, setIndex, focus, snapshot };
}
