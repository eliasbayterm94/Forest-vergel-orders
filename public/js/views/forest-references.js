import { el } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { openModal } from '../ui/modal.js';
import { listView } from '../ui/list.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';

const PROCESS_TYPES = ['Natural', 'Honey', 'Lavado'];

export async function forestReferencesView() {
  const refsRes = await api.references();
  const refs = refsRes.references;

  const renderRef = (r) => el('div', { class: 'ctrm-card ctrm-card-pad' }, [
    el('div', { class: 'flex items-center justify-between gap-2 mb-2' }, [
      el('div', { class: 'flex items-center gap-2 min-w-0 flex-wrap' }, [
        el('span', { class: 'font-display font-semibold text-navy text-[14px] truncate', text: r.name }),
        r.process_type ? el('span', { class: 'ctrm-pill roll', text: r.process_type }) : null,
        el('span', { class: `ctrm-pill ${r.active ? 'ok' : 'muted'}`, text: r.active ? 'activa' : 'inactiva' }),
      ]),
      el('button', {
        class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
        onClick: () => editRef(r),
      }, ['Editar']),
    ]),
    el('div', { class: 'flex flex-wrap text-[12px] text-ink-500 gap-x-4 gap-y-1 font-mono' }, [
      r.process_type ? meta('Proceso', r.process_type) : null,
      r.fermentation_hours != null ? meta('Fermentación', `${r.fermentation_hours} h`) : null,
      !r.process_type && r.fermentation_hours == null
        ? el('span', { class: 'text-ink-300 italic', text: 'sin plantilla' })
        : null,
    ]),
  ]);

  const listContainer = el('div', {});
  function render() {
    listContainer.innerHTML = '';
    listContainer.append(listView({
      items: refs,
      renderItem: renderRef,
      pageSize: 20,
      emptyText: 'Aún no hay referencias. Crea la primera con el botón de arriba.',
      searchPlaceholder: 'Buscar referencia...',
      searchMatch: (r, q) => (r.name || '').toLowerCase().includes(q.toLowerCase()),
      filters: [
        {
          key: 'process_type',
          label: 'Proceso',
          options: PROCESS_TYPES,
          getter: (r) => r.process_type || '',
        },
        {
          key: 'active',
          label: 'Estado',
          options: ['true', 'false'],
          optionLabels: { true: 'Activa', false: 'Inactiva' },
          getter: (r) => String(!!r.active),
        },
      ],
      sorts: [
        { key: 'name_asc', label: 'Nombre A→Z',  getter: (r) => (r.name || '').toLowerCase(), dir: 'asc' },
        { key: 'name_desc', label: 'Nombre Z→A', getter: (r) => (r.name || '').toLowerCase(), dir: 'desc' },
      ],
      defaultSort: 'name_asc',
      totals: [
        { label: 'Referencias', value: (arr) => String(arr.length) },
        { label: 'Activas',     value: (arr) => String(arr.filter((r) => r.active).length) },
      ],
    }));
  }

  async function editRef(existing) {
    const result = await openReferenceModal({ initial: existing });
    if (!result) return;
    try {
      const r = await api.referenceSave({
        name: result.name,
        process_type: result.process_type,
        fermentation_hours: result.fermentation_hours,
        notes: result.notes || null,
      });
      const idx = refs.findIndex((x) => x.id === r.reference.id);
      if (idx >= 0) refs[idx] = r.reference; else refs.push(r.reference);
      refs.sort((a, b) => a.name.localeCompare(b.name));
      toast(`Referencia guardada: ${r.reference.name}`, 'success');
      render();
    } catch (e) { toast(e.message, 'error'); }
  }

  const newBtn = el('button', {
    class: 'ctrm-btn ctrm-btn-yellow uppercase tracking-eyebrow text-[11px] py-2.5 px-5',
    onClick: () => editRef(null),
  }, ['+ Nueva referencia']);

  render();

  return chrome(el('div', {}, [
    pageTitle('Referencias', 'Catálogo maestro · proceso y fermentación por defecto'),
    el('div', { class: 'mb-4 flex justify-end' }, [newBtn]),
    listContainer,
  ]));
}

function meta(label, value) {
  return el('span', { class: 'inline-flex items-baseline gap-1' }, [
    el('span', { class: 'text-ink-300 uppercase tracking-loose text-[10px] font-sans font-semibold', text: label }),
    el('strong', { class: 'text-ink-700 font-mono', text: value }),
  ]);
}

export function openReferenceModal({ initial = null, initialName = '' } = {}) {
  return openModal(({ close }) => {
    const nameInput = el('input', {
      type: 'text', value: initial?.name || initialName || '',
      placeholder: 'Ej: Reserva Forest',
      class: 'ctrm-input',
    });
    const processSelect = el('select', { class: 'ctrm-select' }, [
      el('option', { value: '' }, ['— Sin definir —']),
      ...PROCESS_TYPES.map((p) =>
        el('option', { value: p, selected: initial?.process_type === p }, [p]),
      ),
    ]);
    const fermInput = el('input', {
      type: 'number', min: '0', step: '0.5',
      value: initial?.fermentation_hours != null ? String(initial.fermentation_hours) : '',
      placeholder: 'Opcional',
      class: 'ctrm-input mono',
    });
    const notesInput = el('textarea', {
      rows: '2', placeholder: 'Notas (opcional)',
      class: 'ctrm-textarea',
      value: initial?.notes || '',
    });

    return el('div', { class: 'space-y-3' }, [
      el('label', { class: 'ctrm-label' }, ['Nombre']),
      nameInput,
      el('label', { class: 'ctrm-label mt-2' }, ['Proceso']),
      processSelect,
      el('label', { class: 'ctrm-label mt-2' }, ['Fermentación (horas)']),
      fermInput,
      el('p', { class: 'ctrm-hint', text: 'Opcional. Se autocompleta en el formulario de pedido cuando se elija esta referencia.' }),
      el('label', { class: 'ctrm-label mt-2' }, ['Notas']),
      notesInput,
      el('div', { class: 'flex justify-end gap-2 pt-2' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-primary',
          type: 'button',
          onClick: () => {
            const name = nameInput.value.trim();
            if (!name) { toast('Falta el nombre', 'warning'); return; }
            const ferm = fermInput.value === '' ? null : Number(fermInput.value);
            if (ferm != null && (!Number.isFinite(ferm) || ferm < 0)) {
              toast('Fermentación inválida', 'warning'); return;
            }
            close({
              name,
              process_type: processSelect.value || null,
              fermentation_hours: ferm,
              notes: notesInput.value || null,
            });
          },
        }, ['Guardar']),
      ]),
    ]);
  }, { title: initial ? 'Editar referencia' : 'Nueva referencia', wide: true });
}
