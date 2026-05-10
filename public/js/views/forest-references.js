import { el } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { openModal } from '../ui/modal.js';
import { createMultiCombobox } from '../ui/combobox.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';

export async function forestReferencesView() {
  const [refsRes, varsRes] = await Promise.all([api.references(), api.varieties()]);
  const refs = refsRes.references;
  const allVarieties = varsRes.varieties;

  const list = el('div', { class: 'space-y-2' });
  function render() {
    list.innerHTML = '';
    if (refs.length === 0) {
      list.append(el('p', { class: 'text-[12px] text-ink-300 italic px-1', text: 'Aún no hay referencias. Crea la primera con el botón de arriba.' }));
      return;
    }
    for (const r of refs) {
      list.append(el('div', { class: 'ctrm-card ctrm-card-pad' }, [
        el('div', { class: 'flex items-center justify-between gap-2 mb-2' }, [
          el('div', { class: 'flex items-center gap-2 min-w-0' }, [
            el('span', { class: 'font-display font-semibold text-navy text-[14px] truncate', text: r.name }),
            el('span', { class: `ctrm-pill ${r.active ? 'ok' : 'muted'}`, text: r.active ? 'activa' : 'inactiva' }),
          ]),
          el('button', {
            class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
            onClick: () => editRef(r),
          }, ['Editar']),
        ]),
        el('div', { class: 'flex flex-wrap gap-1' }, (r.varieties || []).map((v) =>
          el('span', { class: 'ctrm-pill dark', text: v.name }),
        )),
      ]));
    }
  }

  async function editRef(existing) {
    const result = await openReferenceModal({
      initial: existing,
      allVarieties,
    });
    if (!result) return;
    try {
      const r = await api.referenceSave({
        name: result.name,
        variety_ids: result.varieties.map((v) => v.id),
        notes: result.notes || null,
      });
      const idx = refs.findIndex((x) => x.id === r.reference.id);
      const norm = { ...r.reference, varieties: r.reference.varieties || [] };
      if (idx >= 0) refs[idx] = norm; else refs.push(norm);
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
    pageTitle('Referencias', 'Catálogo maestro y variedades vinculadas'),
    el('div', { class: 'mb-4 flex justify-end' }, [newBtn]),
    list,
  ]));
}

function openReferenceModal({ initial, allVarieties }) {
  return openModal(({ close }) => {
    const nameInput = el('input', {
      type: 'text', value: initial?.name || '',
      class: 'ctrm-input',
    });
    let chosen = initial?.varieties ? [...initial.varieties] : [];
    const vc = createMultiCombobox({
      placeholder: 'Variedades...',
      items: allVarieties,
      values: chosen,
      onChange: (v) => { chosen = v; },
    });
    const notesInput = el('textarea', {
      rows: '2', placeholder: 'Notas (opcional)',
      class: 'ctrm-textarea',
      value: initial?.notes || '',
    });
    return el('div', { class: 'space-y-3' }, [
      el('label', { class: 'ctrm-label' }, ['Nombre']),
      nameInput,
      el('label', { class: 'ctrm-label mt-2' }, ['Variedades']),
      vc.el,
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
            close({ name, varieties: chosen, notes: notesInput.value });
          },
        }, ['Guardar']),
      ]),
    ]);
  }, { title: initial ? 'Editar referencia' : 'Nueva referencia', wide: true });
}
