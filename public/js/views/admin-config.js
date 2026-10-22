// Admin config view — edita la capacidad semanal y los lead-times
// por proceso. Solo accesible para rol admin.

import { el, clear } from '../ui/el.js';
import { fmtKg, fmtDate } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { toast } from '../ui/toast.js';

export async function adminConfigView() {
  const [cfgRes, leadRes, dtRes, ftRes, ftypesRes, opsRes, usersRes, costRes, supRes] = await Promise.all([
    api.productionConfigGet(),
    api.processLeadTimes(),
    api.dryingTypesList({ include_inactive: 'true' }).catch(() => ({ drying_types: [] })),
    api.fermentationTanksList({ include_inactive: 'true' }).catch(() => ({ fermentation_tanks: [] })),
    api.fermentationTypesList({ include_inactive: 'true' }).catch(() => ({ fermentation_types: [] })),
    api.operatorsList({ include_inactive: 'true' }).catch(() => ({ operators: [] })),
    api.usersList({ include_inactive: 'true' }).catch(() => ({ users: [] })),
    api.costingParamsList().catch(() => ({ costing_parameters: [], in_force: null })),
    api.suppliersList({ include_inactive: 'true' }).catch(() => ({ suppliers: [] })),
  ]);
  let config = cfgRes.config || { weekly_cherry_capacity_kg: 60000 };
  let leadTimes = leadRes.process_lead_times || [];
  let dryingTypes = (dtRes && dtRes.drying_types) || [];
  let fermentationTanks = (ftRes && ftRes.fermentation_tanks) || [];
  let fermentationTypes = (ftypesRes && ftypesRes.fermentation_types) || [];
  let operators = (opsRes && opsRes.operators) || [];
  let users = (usersRes && usersRes.users) || [];
  let costingParams = (costRes && costRes.costing_parameters) || [];
  let costingInForce = (costRes && costRes.in_force) || null;
  let suppliers = (supRes && supRes.suppliers) || [];

  // Asegurar orden estable de procesos
  const ORDER = { Natural: 0, Honey: 1, Lavado: 2 };
  leadTimes = leadTimes.slice().sort((a, b) =>
    (ORDER[a.process_type] ?? 99) - (ORDER[b.process_type] ?? 99));

  const root = el('div', {});
  function redraw() {
    clear(root);
    root.append(
      pageTitle('Configuración', 'Parámetros globales de planificación'),
      capacitySection(config, async (newCap) => {
        try {
          const r = await api.productionConfigUpdate({ weekly_cherry_capacity_kg: newCap });
          config = r.config;
          toast(`Capacidad semanal actualizada a ${fmtKg(config.weekly_cherry_capacity_kg)}`, 'success');
          redraw();
        } catch (e) { toast(e.message, 'error'); }
      }),
      leadTimesSection(leadTimes, async (proc, fields) => {
        try {
          const r = await api.processLeadTimeUpdate({ process_type: proc, ...fields });
          // refresh local list
          leadTimes = leadTimes.map((row) =>
            row.process_type === proc ? { ...row, ...r.row } : row);
          toast(`${proc}: ${describeChanges(fields)}`, 'success');
          redraw();
        } catch (e) { toast(e.message, 'error'); }
      }),
      dryingTypesSection(dryingTypes, async (action, payload) => {
        try {
          if (action === 'create') {
            const r = await api.dryingTypesCreate(payload);
            const found = dryingTypes.find((t) => t.id === r.drying_type.id);
            if (found) Object.assign(found, r.drying_type);
            else dryingTypes.push(r.drying_type);
            toast(r.created ? `Tipo "${r.drying_type.name}" creado` : `Tipo "${r.drying_type.name}" actualizado`, 'success');
          } else if (action === 'update') {
            const r = await api.dryingTypesUpdate(payload);
            dryingTypes = dryingTypes.map((t) => t.id === r.drying_type.id ? r.drying_type : t);
            toast(`"${r.drying_type.name}" actualizado`, 'success');
          }
          redraw();
        } catch (e) { toast(e.message, 'error'); }
      }),
      fermentationTanksSection(fermentationTanks, async (action, payload) => {
        try {
          if (action === 'create') {
            const r = await api.fermentationTanksCreate(payload);
            const found = fermentationTanks.find((t) => t.id === r.fermentation_tank.id);
            if (found) Object.assign(found, r.fermentation_tank);
            else fermentationTanks.push(r.fermentation_tank);
            toast(r.created ? `Tanque "${r.fermentation_tank.name}" creado` : `Tanque "${r.fermentation_tank.name}" actualizado`, 'success');
          } else if (action === 'update') {
            const r = await api.fermentationTanksUpdate(payload);
            fermentationTanks = fermentationTanks.map((t) => t.id === r.fermentation_tank.id ? r.fermentation_tank : t);
            toast(`"${r.fermentation_tank.name}" actualizado`, 'success');
          }
          redraw();
        } catch (e) { toast(e.message, 'error'); }
      }),
      fermentationTypesSection(fermentationTypes, async (action, payload) => {
        try {
          if (action === 'create') {
            const r = await api.fermentationTypesCreate(payload);
            const found = fermentationTypes.find((t) => t.id === r.fermentation_type.id);
            if (found) Object.assign(found, r.fermentation_type);
            else fermentationTypes.push(r.fermentation_type);
            toast(r.created ? `Tipo "${r.fermentation_type.name}" creado` : `Tipo "${r.fermentation_type.name}" actualizado`, 'success');
          } else if (action === 'update') {
            const r = await api.fermentationTypesUpdate(payload);
            fermentationTypes = fermentationTypes.map((t) => t.id === r.fermentation_type.id ? r.fermentation_type : t);
            toast(`"${r.fermentation_type.name}" actualizado`, 'success');
          }
          redraw();
        } catch (e) { toast(e.message, 'error'); }
      }),
      operatorsSection(operators, async (action, payload) => {
        try {
          if (action === 'create') {
            const r = await api.operatorsCreate(payload);
            const found = operators.find((o) => o.id === r.operator.id);
            if (found) Object.assign(found, r.operator);
            else operators.push(r.operator);
            toast(r.created ? `Operario "${r.operator.name}" creado` : `Operario "${r.operator.name}" actualizado`, 'success');
          } else if (action === 'update') {
            const r = await api.operatorsUpdate(payload);
            operators = operators.map((o) => o.id === r.operator.id ? r.operator : o);
            toast(`"${r.operator.name}" actualizado`, 'success');
          }
          redraw();
        } catch (e) { toast(e.message, 'error'); }
      }),
      suppliersSection(suppliers, async (action, payload) => {
        try {
          if (action === 'create') {
            const r = await api.suppliersCreate(payload);
            const found = suppliers.find((x) => x.id === r.supplier.id);
            if (found) Object.assign(found, r.supplier);
            else suppliers.push(r.supplier);
            suppliers.sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'));
            toast(r.created ? `Proveedor "${r.supplier.name}" creado` : `"${r.supplier.name}" ya existía`, 'success');
          } else if (action === 'update') {
            const r = await api.suppliersUpdate(payload);
            suppliers = suppliers.map((x) => x.id === r.supplier.id ? r.supplier : x);
            toast(`"${r.supplier.name}" actualizado`, 'success');
          }
          redraw();
        } catch (e) { toast(e.message, 'error', 7000); }
      }),
      costingSection(costingParams, costingInForce, async (payload) => {
        try {
          const r = await api.costingParamsCreate(payload);
          costingParams = [r.costing_parameters, ...costingParams];
          const d = String(r.costing_parameters.effective_from).slice(0, 10);
          if (!costingInForce || d <= new Date().toISOString().slice(0, 10)) {
            costingInForce = r.costing_parameters;
          }
          toast(`Tarifas vigentes desde ${d} guardadas`, 'success');
          redraw();
        } catch (e) { toast(e.message, 'error', 7000); }
      }),
      usersSection(users, async (action, payload) => {
        try {
          if (action === 'create') {
            const r = await api.usersCreate(payload);
            users.push(r.user);
            toast(`Usuario "${r.user.username}" creado`, 'success');
          } else if (action === 'update') {
            const r = await api.usersUpdate(payload);
            users = users.map((u) => u.id === r.user.id ? r.user : u);
            toast(r.password_changed
              ? `Contraseña de "${r.user.username}" actualizada`
              : `"${r.user.username}" actualizado`, 'success');
          }
          redraw();
        } catch (e) { toast(e.message, 'error'); }
      }),
      footerNote(config),
    );
  }
  redraw();

  return chrome(root);
}

function describeChanges(fields) {
  const parts = [];
  if (fields.drying_days != null) parts.push(`drying=${fields.drying_days}d`);
  if (fields.processing_days != null) parts.push(`proc=${fields.processing_days}d`);
  if (fields.dried_to_green_divisor != null) parts.push(`divisor=${fields.dried_to_green_divisor}`);
  return parts.length > 0 ? parts.join(' · ') : 'actualizado';
}

// ─── Proveedores ────────────────────────────────────────────────────
// Quién entrega materia prima, y la franquicia de flotes pactada con
// cada uno. El TIPO no se edita: cambiar own <-> third_party
// reescribiría el costeo de todas sus recepciones pasadas, y los
// snapshots están congelados. Por eso el servidor lo rechaza.
function suppliersSection(suppliers, onAction) {
  const nameInput = el('input', { type: 'text', placeholder: 'Ej: Finca La Esperanza', class: 'ctrm-input', maxlength: '120' });
  const regionInput = el('input', { type: 'text', placeholder: 'Ej: Manzanares, Caldas', class: 'ctrm-input', maxlength: '80' });
  const kindSelect = el('select', { class: 'ctrm-select' }, [
    el('option', { value: 'third_party', selected: true }, ['Tercero']),
    el('option', { value: 'own' }, ['Propio']),
  ]);
  const addBtn = el('button', {
    class: 'ctrm-btn ctrm-btn-primary', type: 'button',
    onClick: async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      await onAction('create', {
        name, kind: kindSelect.value, region: regionInput.value.trim() || undefined,
      });
      nameInput.value = ''; regionInput.value = '';
    },
  }, ['+ Agregar']);

  const rows = (suppliers || []).map((sup) => {
    const renameInput = el('input', { type: 'text', value: sup.name, class: 'ctrm-input text-[12px]' });
    const regionEdit = el('input', { type: 'text', value: sup.region || '', placeholder: '—', class: 'ctrm-input text-[12px]' });
    // Stored as a fraction, shown as a percentage: nobody negotiates in
    // fractions, and 0.05 typed where 5 was meant is a 100x error.
    const franchiseEdit = el('input', {
      type: 'number', min: '0', max: '100', step: '0.1', class: 'ctrm-input mono text-[12px]',
      value: sup.floater_franchise_pct == null ? '' : String(Math.round(Number(sup.floater_franchise_pct) * 1000) / 10),
      placeholder: '0',
      title: 'Solo se descuenta lo que pase de este %. Vacío o 0 = sin franquicia.',
    });
    return el('div', {
      class: `grid grid-cols-[1fr_1fr_5rem_4.5rem_auto_auto] items-center gap-2 py-2 border-t border-sand ${sup.active ? '' : 'opacity-60'}`,
    }, [
      renameInput,
      regionEdit,
      franchiseEdit,
      el('span', { class: 'text-[11px] text-ink-500', text: sup.kind === 'own' ? 'Propio' : 'Tercero' }),
      el('button', {
        class: 'ctrm-btn ctrm-btn-soft ctrm-btn-xs', type: 'button',
        onClick: () => {
          const raw = franchiseEdit.value.trim();
          if (raw !== '') {
            const n = Number(raw);
            if (!Number.isFinite(n) || n < 0 || n > 100) {
              toast('La franquicia va entre 0 y 100 %', 'warning'); return;
            }
          }
          onAction('update', {
            id: sup.id,
            fields: {
              name: renameInput.value.trim(),
              region: regionEdit.value.trim() || null,
              floater_franchise_pct: raw === '' ? null : Number(raw) / 100,
            },
          });
        },
      }, ['Guardar']),
      el('button', {
        class: `ctrm-btn ctrm-btn-soft ctrm-btn-xs ${sup.active ? 'text-crit' : 'text-ok'}`,
        type: 'button',
        onClick: () => onAction('update', { id: sup.id, fields: { active: !sup.active } }),
      }, [sup.active ? 'Desactivar' : 'Reactivar']),
    ]);
  });

  return el('section', { class: 'ctrm-card ctrm-card-pad mt-4 space-y-3' }, [
    el('p', { class: 'eyebrow text-[10px]', text: 'Proveedores' }),
    el('p', { class: 'text-[12px] text-ink-500',
      text: 'Quién entrega materia prima. "Propio" se costea con la tarifa T2 y no lleva precio de compra; '
          + '"Tercero" se costea al precio pagado. El tipo no se puede cambiar después.' }),
    el('p', { class: 'text-[11px] text-ink-500',
      text: 'Franquicia de flotes: solo se descuenta lo que pase de ese %. Con 5 %, unos flotes del 9,8 % '
          + 'dan un descuento sugerido de 4,8 % — y esos 5 puntos que absorbes salen en la recepción, en pesos.' }),
    el('div', { class: 'grid grid-cols-[1fr_1fr_8rem_auto] gap-2 items-end pb-2 border-b border-sand' }, [
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'Nombre' }), nameInput]),
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'Región (opcional)' }), regionInput]),
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'Tipo' }), kindSelect]),
      addBtn,
    ]),
    rows.length > 0
      ? el('div', { class: 'grid grid-cols-[1fr_1fr_5rem_4.5rem_auto_auto] gap-2 text-[10px] uppercase tracking-eyebrow text-ink-500 pt-2' }, [
          el('span', { text: 'Nombre' }),
          el('span', { text: 'Región' }),
          el('span', { text: 'Franq. %' }),
          el('span', { text: 'Tipo' }),
          el('span', {}, []),
          el('span', {}, []),
        ])
      : null,
    ...rows,
    rows.length === 0
      ? el('p', { class: 'text-[12px] text-ink-300 italic py-3 text-center', text: 'Aún no hay proveedores. Agrega uno arriba.' })
      : null,
  ]);
}

// ─── Capacity section ───────────────────────────────────────────────
function capacitySection(config, onSave) {
  const input = el('input', {
    type: 'number', min: '1', step: '100',
    value: String(config.weekly_cherry_capacity_kg),
    class: 'ctrm-input mono',
  });
  const help = el('p', { class: 'ctrm-hint mt-1' });
  const updateHelp = () => {
    const v = Number(input.value || 0);
    const greenEquiv = v / 7.65;
    help.textContent = v > 0
      ? `≈ ${fmtKg(greenEquiv)} de verde / semana (÷ 7.65)`
      : 'Capacidad debe ser > 0';
  };
  input.addEventListener('input', updateHelp);
  updateHelp();

  const saveBtn = el('button', {
    class: 'ctrm-btn ctrm-btn-primary',
    type: 'button',
    onClick: () => {
      const v = Number(input.value);
      if (!(v > 0)) { toast('Capacidad inválida', 'warning'); return; }
      if (v === config.weekly_cherry_capacity_kg) {
        toast('Sin cambios', 'info', 1500);
        return;
      }
      onSave(v);
    },
  }, ['Guardar']);

  return el('section', { class: 'ctrm-card ctrm-card-pad mb-5' }, [
    el('h3', { class: 'eyebrow mb-2', text: 'Capacidad semanal de procesamiento' }),
    el('p', { class: 'text-[12px] text-ink-500 mb-3' }, [
      'Volumen máximo de cereza que la planta puede procesar en una semana ISO. ',
      'Se usa en /finca/cola y en el panel "Carga semanal" para marcar las semanas sobrecargadas.',
    ]),
    el('div', { class: 'grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2 items-end' }, [
      el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'kg cereza / semana' }),
        input,
        help,
      ]),
      saveBtn,
    ]),
  ]);
}

// ─── Lead times per process ─────────────────────────────────────────
function leadTimesSection(rows, onSave) {
  if (rows.length === 0) {
    return el('section', { class: 'ctrm-card ctrm-card-pad mb-5' }, [
      el('p', { class: 'text-ink-300 italic', text: 'No hay procesos cargados.' }),
    ]);
  }

  return el('section', { class: 'ctrm-card ctrm-card-pad mb-5' }, [
    el('h3', { class: 'eyebrow mb-2', text: 'Lead times por proceso' }),
    el('p', { class: 'text-[12px] text-ink-500 mb-3' }, [
      'Días de drying y procesamiento previo (fermentación + despulpado + secado al sol). ',
      'El "drying-start" máximo de un pedido = entrega − (drying + procesamiento). ',
      'El divisor seco→verde se usa cuando un lote se cierra sin factor explícito.',
    ]),
    el('div', { class: 'space-y-2' }, rows.map((r) => leadTimeRow(r, onSave))),
  ]);
}

function leadTimeRow(row, onSave) {
  const dryingInput = el('input', {
    type: 'number', min: '1', step: '1',
    value: String(row.drying_days), class: 'ctrm-input mono w-24',
  });
  const procInput = el('input', {
    type: 'number', min: '0', step: '1',
    value: String(row.processing_days ?? 6), class: 'ctrm-input mono w-24',
  });
  const divisorInput = el('input', {
    type: 'number', min: '0.01', step: '0.01',
    value: String(row.dried_to_green_divisor), class: 'ctrm-input mono w-24',
  });

  const totalHint = el('span', { class: 'text-[11px] text-ink-500 font-mono' });
  const updateHint = () => {
    const d = Number(dryingInput.value || 0);
    const p = Number(procInput.value || 0);
    totalHint.textContent = (d > 0 && p >= 0)
      ? `Lead total: ${d + p}d antes de la entrega`
      : '';
  };
  dryingInput.addEventListener('input', updateHint);
  procInput.addEventListener('input', updateHint);
  updateHint();

  const saveBtn = el('button', {
    class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
    type: 'button',
    onClick: () => {
      const fields = {};
      const d = Number(dryingInput.value);
      const p = Number(procInput.value);
      const v = Number(divisorInput.value);
      if (Number.isFinite(d) && d > 0 && d !== Number(row.drying_days)) fields.drying_days = d;
      if (Number.isFinite(p) && p >= 0 && p !== Number(row.processing_days ?? 6)) fields.processing_days = p;
      if (Number.isFinite(v) && v > 0 && Math.abs(v - Number(row.dried_to_green_divisor)) > 1e-9) fields.dried_to_green_divisor = v;
      if (Object.keys(fields).length === 0) { toast('Sin cambios', 'info', 1500); return; }
      onSave(row.process_type, fields);
    },
  }, ['Guardar']);

  return el('div', {
    class: 'rounded-md border border-sand p-3',
  }, [
    el('div', { class: 'flex items-center gap-2 mb-2 flex-wrap' }, [
      el('span', { class: 'ctrm-pill dark', text: row.process_type }),
      totalHint,
    ]),
    el('div', { class: 'grid grid-cols-2 sm:grid-cols-[1fr_1fr_1fr_auto] gap-3 items-end' }, [
      el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'Drying (d)' }),
        dryingInput,
      ]),
      el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'Procesamiento (d)' }),
        procInput,
      ]),
      el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'Divisor seco→verde' }),
        divisorInput,
      ]),
      saveBtn,
    ]),
  ]);
}

function footerNote(config) {
  return el('p', { class: 'text-[11px] text-ink-300 italic mt-3' }, [
    config.updated_at
      ? `Última actualización: ${fmtDate(config.updated_at)}${config.updated_by ? ` por ${config.updated_by}` : ''}.`
      : '',
    ' Los cambios se reflejan en /finca/cola y el dashboard al recargar (puede tomar unos segundos por el cache del servidor).',
  ]);
}

// ─── Tipos de secado (administrables) ───────────────────────────────
// Permite agregar/reactivar/desactivar los equipos donde se manda a
// secar el café (Silos, Patio, Nuna, etc.). Los lotes históricos
// preservan el nombre referenciado aunque el tipo se desactive.
function dryingTypesSection(types, onAction) {
  const nameInput = el('input', {
    type: 'text', placeholder: 'Ej: Nuna', class: 'ctrm-input', maxlength: '60',
  });
  const kindInput = el('input', {
    type: 'text', placeholder: 'Opcional: Mecánico, Natural, …',
    class: 'ctrm-input',
  });
  const addBtn = el('button', {
    class: 'ctrm-btn ctrm-btn-primary',
    type: 'button',
    onClick: async () => {
      const name = nameInput.value.trim();
      if (!name) { return; }
      await onAction('create', { name, kind: kindInput.value.trim() || undefined });
      nameInput.value = ''; kindInput.value = '';
    },
  }, ['+ Agregar tipo']);

  const rows = (types || []).map((t) => {
    const renameInput = el('input', { type: 'text', value: t.name, class: 'ctrm-input mono text-[12px]' });
    const kindEditInput = el('input', { type: 'text', value: t.kind || '', placeholder: '—', class: 'ctrm-input text-[12px]' });
    return el('div', {
      class: `grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2 py-2 border-t border-sand ${t.active ? '' : 'opacity-60'}`,
    }, [
      renameInput,
      kindEditInput,
      el('button', {
        class: 'ctrm-btn ctrm-btn-soft ctrm-btn-xs',
        type: 'button',
        onClick: () => onAction('update', {
          id: t.id,
          fields: { name: renameInput.value.trim(), kind: kindEditInput.value.trim() || null },
        }),
      }, ['Guardar']),
      el('button', {
        class: `ctrm-btn ctrm-btn-soft ctrm-btn-xs ${t.active ? 'text-crit' : 'text-ok'}`,
        type: 'button',
        onClick: () => onAction('update', { id: t.id, fields: { active: !t.active } }),
      }, [t.active ? 'Desactivar' : 'Reactivar']),
    ]);
  });

  return el('section', { class: 'ctrm-card ctrm-card-pad mt-4 space-y-3' }, [
    el('p', { class: 'eyebrow text-[10px]', text: 'Tipos de secado' }),
    el('p', { class: 'text-[12px] text-ink-500',
      text: 'Equipos/lugares donde se manda a secar el café. Aparecen en el modal de "→ Secado" para que el operario los seleccione.' }),
    el('div', { class: 'grid grid-cols-[1fr_1fr_auto] gap-2 items-end pb-2 border-b border-sand' }, [
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'Nombre' }), nameInput]),
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'Categoría (opcional)' }), kindInput]),
      addBtn,
    ]),
    rows.length > 0
      ? el('div', { class: 'grid grid-cols-[1fr_1fr_auto_auto] gap-2 text-[10px] uppercase tracking-eyebrow text-ink-500 pt-2' }, [
          el('span', { text: 'Nombre' }),
          el('span', { text: 'Categoría' }),
          el('span', {}, []),
          el('span', {}, []),
        ])
      : null,
    ...rows,
    rows.length === 0
      ? el('p', { class: 'text-[12px] text-ink-300 italic py-3 text-center', text: 'Aún no hay tipos. Agrega uno arriba.' })
      : null,
  ]);
}

// ─── Tanques de fermentación (administrables) ───────────────────────
// Mismo patrón que drying types pero para tanques/recipientes donde
// se está fermentando el café. Aparecen como multi-select en el
// modal de crear lote (single y bulk).
function fermentationTanksSection(tanks, onAction) {
  const nameInput = el('input', {
    type: 'text', placeholder: 'Ej: Tanque 1', class: 'ctrm-input', maxlength: '60',
  });
  const kindInput = el('input', {
    type: 'text', placeholder: 'Opcional: Plástico, Acero, …',
    class: 'ctrm-input',
  });
  const addBtn = el('button', {
    class: 'ctrm-btn ctrm-btn-primary',
    type: 'button',
    onClick: async () => {
      const name = nameInput.value.trim();
      if (!name) { return; }
      await onAction('create', { name, kind: kindInput.value.trim() || undefined });
      nameInput.value = ''; kindInput.value = '';
    },
  }, ['+ Agregar tanque']);

  const rows = (tanks || []).map((t) => {
    const renameInput = el('input', { type: 'text', value: t.name, class: 'ctrm-input mono text-[12px]' });
    const kindEditInput = el('input', { type: 'text', value: t.kind || '', placeholder: '—', class: 'ctrm-input text-[12px]' });
    return el('div', {
      class: `grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2 py-2 border-t border-sand ${t.active ? '' : 'opacity-60'}`,
    }, [
      renameInput,
      kindEditInput,
      el('button', {
        class: 'ctrm-btn ctrm-btn-soft ctrm-btn-xs',
        type: 'button',
        onClick: () => onAction('update', {
          id: t.id,
          fields: { name: renameInput.value.trim(), kind: kindEditInput.value.trim() || null },
        }),
      }, ['Guardar']),
      el('button', {
        class: `ctrm-btn ctrm-btn-soft ctrm-btn-xs ${t.active ? 'text-crit' : 'text-ok'}`,
        type: 'button',
        onClick: () => onAction('update', { id: t.id, fields: { active: !t.active } }),
      }, [t.active ? 'Desactivar' : 'Reactivar']),
    ]);
  });

  return el('section', { class: 'ctrm-card ctrm-card-pad mt-4 space-y-3' }, [
    el('p', { class: 'eyebrow text-[10px]', text: 'Tanques de fermentación' }),
    el('p', { class: 'text-[12px] text-ink-500',
      text: 'Recipientes donde se fermenta el café. Aparecen como multi-select en el modal de crear lote.' }),
    el('div', { class: 'grid grid-cols-[1fr_1fr_auto] gap-2 items-end pb-2 border-b border-sand' }, [
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'Nombre' }), nameInput]),
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'Categoría (opcional)' }), kindInput]),
      addBtn,
    ]),
    rows.length > 0
      ? el('div', { class: 'grid grid-cols-[1fr_1fr_auto_auto] gap-2 text-[10px] uppercase tracking-eyebrow text-ink-500 pt-2' }, [
          el('span', { text: 'Nombre' }),
          el('span', { text: 'Categoría' }),
          el('span', {}, []),
          el('span', {}, []),
        ])
      : null,
    ...rows,
    rows.length === 0
      ? el('p', { class: 'text-[12px] text-ink-300 italic py-3 text-center', text: 'Aún no hay tanques. Agrega uno arriba.' })
      : null,
  ]);
}

// ─── Tipos de fermentación (administrables) ─────────────────────────
// Mismo patrón. Aparecen como multi-select en el modal de crear lote.
function fermentationTypesSection(types, onAction) {
  const nameInput = el('input', {
    type: 'text', placeholder: 'Ej: Aeróbico', class: 'ctrm-input', maxlength: '60',
  });
  const kindInput = el('input', {
    type: 'text', placeholder: 'Opcional', class: 'ctrm-input',
  });
  const addBtn = el('button', {
    class: 'ctrm-btn ctrm-btn-primary',
    type: 'button',
    onClick: async () => {
      const name = nameInput.value.trim();
      if (!name) { return; }
      await onAction('create', { name, kind: kindInput.value.trim() || undefined });
      nameInput.value = ''; kindInput.value = '';
    },
  }, ['+ Agregar tipo']);

  const rows = (types || []).map((t) => {
    const renameInput = el('input', { type: 'text', value: t.name, class: 'ctrm-input mono text-[12px]' });
    const kindEditInput = el('input', { type: 'text', value: t.kind || '', placeholder: '—', class: 'ctrm-input text-[12px]' });
    return el('div', {
      class: `grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2 py-2 border-t border-sand ${t.active ? '' : 'opacity-60'}`,
    }, [
      renameInput,
      kindEditInput,
      el('button', {
        class: 'ctrm-btn ctrm-btn-soft ctrm-btn-xs',
        type: 'button',
        onClick: () => onAction('update', {
          id: t.id,
          fields: { name: renameInput.value.trim(), kind: kindEditInput.value.trim() || null },
        }),
      }, ['Guardar']),
      el('button', {
        class: `ctrm-btn ctrm-btn-soft ctrm-btn-xs ${t.active ? 'text-crit' : 'text-ok'}`,
        type: 'button',
        onClick: () => onAction('update', { id: t.id, fields: { active: !t.active } }),
      }, [t.active ? 'Desactivar' : 'Reactivar']),
    ]);
  });

  return el('section', { class: 'ctrm-card ctrm-card-pad mt-4 space-y-3' }, [
    el('p', { class: 'eyebrow text-[10px]', text: 'Tipos de fermentación' }),
    el('p', { class: 'text-[12px] text-ink-500',
      text: 'Métodos aplicados durante la fermentación (Aeróbico, Anaeróbico, etc). Aparecen como multi-select en el modal de crear lote.' }),
    el('div', { class: 'grid grid-cols-[1fr_1fr_auto] gap-2 items-end pb-2 border-b border-sand' }, [
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'Nombre' }), nameInput]),
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'Categoría (opcional)' }), kindInput]),
      addBtn,
    ]),
    rows.length > 0
      ? el('div', { class: 'grid grid-cols-[1fr_1fr_auto_auto] gap-2 text-[10px] uppercase tracking-eyebrow text-ink-500 pt-2' }, [
          el('span', { text: 'Nombre' }),
          el('span', { text: 'Categoría' }),
          el('span', {}, []),
          el('span', {}, []),
        ])
      : null,
    ...rows,
    rows.length === 0
      ? el('p', { class: 'text-[12px] text-ink-300 italic py-3 text-center', text: 'Aún no hay tipos. Agrega uno arriba.' })
      : null,
  ]);
}

// ─── Costing tariffs (versioned) ────────────────────────────────────
// T1 y T2 por fecha de vigencia. Una versión nueva aplica a las salidas
// en seco desde su fecha y NUNCA toca lo que ya salió: los snapshots
// copian las tarifas. Ver migración 0052.
//
// No hay porcentajes por etapa de ingreso a propósito: T1 es plano
// sobre kg netos que entran. El denominador del presupuesto debe
// medirse igual (kg netos, cualquier etapa) o el cierre mensual
// arrastra un sesgo permanente.
const NF_COP_CFG = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
const copCfg = (n) => (n == null ? '—' : `$ ${NF_COP_CFG.format(Math.round(Number(n)))}`);

function costingSection(versions, inForce, onCreate) {
  const dateInput = el('input', { type: 'date', class: 'ctrm-input' });
  const t1Input = el('input', { type: 'number', min: '0', step: '0.01', class: 'ctrm-input mono', placeholder: 'COP / kg neto' });
  const t2Input = el('input', { type: 'number', min: '0', step: '0.01', class: 'ctrm-input mono', placeholder: 'COP / kg neto' });
  const mandateInput = el('input', { type: 'number', min: '0', step: '1', class: 'ctrm-input mono', placeholder: 'Opcional' });
  const agriInput = el('input', { type: 'number', min: '0', step: '1', class: 'ctrm-input mono', placeholder: 'Opcional' });
  const budgetInput = el('input', { type: 'number', min: '0', step: '1', class: 'ctrm-input mono', placeholder: 'Opcional' });
  const budgetOwnInput = el('input', { type: 'number', min: '0', step: '1', class: 'ctrm-input mono', placeholder: 'Opcional' });

  // Ayuda viva: si pone mandato, agrícola y presupuesto, calcula las
  // tarifas que se derivarían, para contrastarlas con lo que escribió.
  const derived = el('p', { class: 'text-[11px] text-ink-500' });
  function recalc() {
    const m = Number(mandateInput.value), a = Number(agriInput.value);
    const b = Number(budgetInput.value), bo = Number(budgetOwnInput.value);
    const parts = [];
    if (m > 0 && a >= 0 && b > 0) parts.push(`T1 sugerido: ${copCfg((m - a) / b)}`);
    if (a > 0 && bo > 0) parts.push(`T2 sugerido: ${copCfg(a / bo)}`);
    derived.textContent = parts.length
      ? `${parts.join(' · ')} — compáralo con lo que escribiste arriba.`
      : 'Si llenas mandato, costo agrícola y kg presupuestados, acá aparecen las tarifas sugeridas.';
  }
  for (const i of [mandateInput, agriInput, budgetInput, budgetOwnInput]) {
    i.addEventListener('input', recalc);
  }
  recalc();

  const addBtn = el('button', { class: 'ctrm-btn ctrm-btn-primary', type: 'button' }, ['Guardar versión']);
  addBtn.addEventListener('click', () => {
    if (!dateInput.value) { toast('Indica desde cuándo rige', 'warning'); return; }
    const t1 = Number(t1Input.value), t2 = Number(t2Input.value);
    if (!(t1 >= 0) || t1Input.value === '') { toast('T1 debe ser un número >= 0', 'warning'); return; }
    if (!(t2 >= 0) || t2Input.value === '') { toast('T2 debe ser un número >= 0', 'warning'); return; }
    const opt = (inp) => (inp.value === '' ? null : Number(inp.value));
    onCreate({
      effective_from: dateInput.value,
      t1_per_kg_net: t1,
      t2_per_kg_own_net: t2,
      annual_mandate_cop: opt(mandateInput),
      annual_agricultural_cop: opt(agriInput),
      budget_kg_net: opt(budgetInput),
      budget_kg_own_net: opt(budgetOwnInput),
    });
    dateInput.value = ''; t1Input.value = ''; t2Input.value = '';
    mandateInput.value = ''; agriInput.value = ''; budgetInput.value = ''; budgetOwnInput.value = '';
    recalc();
  });

  const rows = (versions || []).map((v) => {
    const isForce = inForce && inForce.id === v.id;
    return el('div', { class: `grid grid-cols-[auto_1fr_1fr_auto] items-center gap-2 py-1.5 border-t border-sand text-[12px]` }, [
      el('span', { class: 'font-mono', text: String(v.effective_from).slice(0, 10) }),
      el('span', { class: 'font-mono text-right', text: `T1 ${copCfg(v.t1_per_kg_net)}` }),
      el('span', { class: 'font-mono text-right', text: `T2 ${copCfg(v.t2_per_kg_own_net)}` }),
      isForce
        ? el('span', { class: 'ctrm-pill ok text-[10px]', text: 'vigente' })
        : el('span', { class: 'text-[10px] text-ink-300', text: '—' }),
    ]);
  });

  return el('section', { class: 'ctrm-card ctrm-card-pad mt-4 space-y-3' }, [
    el('p', { class: 'eyebrow text-[10px]', text: 'Tarifas de costeo' }),
    el('p', { class: 'text-[12px] text-ink-500',
      text: 'T1 (procesamiento) y T2 (producción propia), en COP por kg NETO que entra. '
          + 'Una versión nueva aplica desde su fecha hacia adelante y no modifica ningún lote ya costeado. '
          + 'T1 se cobra plano, sin importar la etapa de ingreso.' }),
    el('div', { class: 'grid grid-cols-1 sm:grid-cols-3 gap-2' }, [
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'Rige desde' }), dateInput]),
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'T1 · procesamiento' }), t1Input]),
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'T2 · producción propia' }), t2Input]),
    ]),
    el('details', { class: 'text-[12px]' }, [
      el('summary', { class: 'cursor-pointer text-ink-500', text: 'De dónde salieron las tarifas (opcional, queda en el registro)' }),
      el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2' }, [
        el('div', {}, [el('label', { class: 'ctrm-label', text: 'Mandato anual (COP)' }), mandateInput]),
        el('div', {}, [el('label', { class: 'ctrm-label', text: 'Costo agrícola anual (COP)' }), agriInput]),
        el('div', {}, [el('label', { class: 'ctrm-label', text: 'kg netos presupuestados' }), budgetInput]),
        el('div', {}, [el('label', { class: 'ctrm-label', text: 'kg netos propios presupuestados' }), budgetOwnInput]),
      ]),
      el('p', { class: 'ctrm-hint mt-1',
        text: 'Los kg presupuestados deben contar TODO lo que entra (cereza, despulpado y seco), neto de flotes — igual que se cobra T1.' }),
      derived,
    ]),
    addBtn,
    rows.length > 0
      ? el('div', { class: 'pt-2' }, [el('p', { class: 'ctrm-label mb-1', text: 'Versiones' }), ...rows])
      : el('p', { class: 'text-[12px] text-ink-300 italic py-2 text-center',
          text: 'Sin tarifas definidas. Hasta que exista una versión, los lotes no se pueden costear.' }),
  ]);
}

// ─── Users section ──────────────────────────────────────────────────
// Usuarios del sistema: quién puede entrar, con qué rol, y reseteo de
// contraseñas. Reemplaza las claves compartidas en env vars de Netlify
// (cambiarlas exigía redeploy). Ver migración 0048_users.sql.
const ROLE_LABELS = {
  forest: 'Forest (comercial)',
  finca:  'El Vergel (finca)',
  admin:  'Admin',
};

function roleSelect(value) {
  return el('select', { class: 'ctrm-select text-[12px]' },
    Object.entries(ROLE_LABELS).map(([v, label]) =>
      el('option', v === value ? { value: v, selected: 'selected' } : { value: v }, [label])));
}

function usersSection(users, onAction) {
  const newUser = el('input', {
    type: 'text', placeholder: 'ej: juan.perez', class: 'ctrm-input mono text-[12px]',
    maxlength: '40', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
  });
  const newName = el('input', {
    type: 'text', placeholder: 'Juan Pérez', class: 'ctrm-input text-[12px]', maxlength: '80',
  });
  const newPass = el('input', {
    type: 'text', placeholder: 'mínimo 8 caracteres', class: 'ctrm-input mono text-[12px]',
    autocomplete: 'off',
  });
  const newRole = roleSelect('finca');

  const addBtn = el('button', {
    class: 'ctrm-btn ctrm-btn-primary',
    type: 'button',
    onClick: async () => {
      const username = newUser.value.trim();
      const password = newPass.value;
      if (!username) { toast('Ingresa el usuario', 'warning'); return; }
      if (password.length < 8) { toast('La contraseña debe tener al menos 8 caracteres', 'warning'); return; }
      await onAction('create', {
        username,
        password,
        role: newRole.value,
        full_name: newName.value.trim() || null,
      });
      newUser.value = ''; newName.value = ''; newPass.value = '';
    },
  }, ['+ Crear usuario']);

  const rows = (users || []).map((u) => {
    const rSel = roleSelect(u.role);
    const resetInput = el('input', {
      type: 'text', placeholder: 'nueva contraseña', class: 'ctrm-input mono text-[11px]',
      autocomplete: 'off',
    });
    return el('div', {
      class: `py-2 border-t border-sand ${u.active ? '' : 'opacity-60'}`,
    }, [
      el('div', { class: 'grid grid-cols-[1fr_auto_auto] items-center gap-2' }, [
        el('div', { class: 'min-w-0' }, [
          el('p', { class: 'font-mono text-[12px] text-navy truncate', text: u.username }),
          el('p', { class: 'text-[10px] text-ink-300 truncate',
            text: [u.full_name, u.last_login_at ? `último ingreso ${fmtDate(u.last_login_at)}` : 'nunca ingresó']
              .filter(Boolean).join(' · ') }),
        ]),
        rSel,
        el('button', {
          class: `ctrm-btn ctrm-btn-soft ctrm-btn-xs ${u.active ? 'text-crit' : 'text-ok'}`,
          type: 'button',
          onClick: () => onAction('update', { id: u.id, fields: { active: !u.active } }),
        }, [u.active ? 'Desactivar' : 'Reactivar']),
      ]),
      el('div', { class: 'grid grid-cols-[1fr_auto_auto] items-center gap-2 mt-1.5' }, [
        resetInput,
        el('button', {
          class: 'ctrm-btn ctrm-btn-soft ctrm-btn-xs',
          type: 'button',
          onClick: () => {
            const pwd = resetInput.value;
            if (pwd.length < 8) { toast('La contraseña debe tener al menos 8 caracteres', 'warning'); return; }
            resetInput.value = '';
            return onAction('update', { id: u.id, fields: { password: pwd } });
          },
        }, ['Resetear clave']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-soft ctrm-btn-xs',
          type: 'button',
          onClick: () => onAction('update', { id: u.id, fields: { role: rSel.value } }),
        }, ['Guardar rol']),
      ]),
    ]);
  });

  return el('section', { class: 'ctrm-card ctrm-card-pad mt-4 space-y-3' }, [
    el('p', { class: 'eyebrow text-[10px]', text: 'Usuarios y accesos' }),
    el('p', { class: 'text-[12px] text-ink-500',
      text: 'Quién puede entrar al sistema y con qué rol. Las contraseñas se guardan cifradas en la base de datos: cambiar una tiene efecto inmediato, sin redeploy. Al crear un usuario, entrégale la contraseña por un canal seguro y pídele que la cambies contigo si la comparte.' }),
    el('div', { class: 'grid grid-cols-[1fr_1fr] gap-2 pb-2' }, [
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'Usuario' }), newUser]),
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'Nombre completo' }), newName]),
    ]),
    el('div', { class: 'grid grid-cols-[1fr_1fr_auto] gap-2 items-end pb-2 border-b border-sand' }, [
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'Contraseña inicial' }), newPass]),
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'Rol' }), newRole]),
      addBtn,
    ]),
    ...rows,
    rows.length === 0
      ? el('p', { class: 'text-[12px] text-ink-300 italic py-3 text-center',
          text: 'Aún no hay usuarios. Mientras no exista ninguno, el login sigue aceptando las claves por rol de Netlify.' })
      : null,
  ]);
}

// ─── Operators section ──────────────────────────────────────────────
// Operarios para accountability individual: el usuario elige "quién
// es" en el sidebar y su nombre viaja en cada acción auditada.
function operatorsSection(operators, onAction) {
  const nameInput = el('input', {
    type: 'text', placeholder: 'Ej: Juan Pérez', class: 'ctrm-input', maxlength: '60',
  });
  const addBtn = el('button', {
    class: 'ctrm-btn ctrm-btn-primary',
    type: 'button',
    onClick: async () => {
      const name = nameInput.value.trim();
      if (!name) { return; }
      await onAction('create', { name });
      nameInput.value = '';
    },
  }, ['+ Agregar operario']);

  const rows = (operators || []).map((o) => {
    const renameInput = el('input', { type: 'text', value: o.name, class: 'ctrm-input mono text-[12px]' });
    return el('div', {
      class: `grid grid-cols-[1fr_auto_auto] items-center gap-2 py-2 border-t border-sand ${o.active ? '' : 'opacity-60'}`,
    }, [
      renameInput,
      el('button', {
        class: 'ctrm-btn ctrm-btn-soft ctrm-btn-xs',
        type: 'button',
        onClick: () => onAction('update', {
          id: o.id,
          fields: { name: renameInput.value.trim() },
        }),
      }, ['Guardar']),
      el('button', {
        class: `ctrm-btn ctrm-btn-soft ctrm-btn-xs ${o.active ? 'text-crit' : 'text-ok'}`,
        type: 'button',
        onClick: () => onAction('update', { id: o.id, fields: { active: !o.active } }),
      }, [o.active ? 'Desactivar' : 'Reactivar']),
    ]);
  });

  return el('section', { class: 'ctrm-card ctrm-card-pad mt-4 space-y-3' }, [
    el('p', { class: 'eyebrow text-[10px]', text: 'Operarios' }),
    el('p', { class: 'text-[12px] text-ink-500',
      text: 'Personas que operan el sistema. Cada usuario elige quién es en el sidebar, y su nombre queda en las auditorías (ajustes de peso, ciclos retroactivos, cierres manuales, cancelaciones).' }),
    el('div', { class: 'grid grid-cols-[1fr_auto] gap-2 items-end pb-2 border-b border-sand' }, [
      el('div', {}, [el('label', { class: 'ctrm-label', text: 'Nombre' }), nameInput]),
      addBtn,
    ]),
    ...rows,
    rows.length === 0
      ? el('p', { class: 'text-[12px] text-ink-300 italic py-3 text-center', text: 'Aún no hay operarios. Agrega uno arriba.' })
      : null,
  ]);
}
