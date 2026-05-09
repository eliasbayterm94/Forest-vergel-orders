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
      list.append(el('p', { class: 'text-sm text-slate-400 italic px-1', text: 'Aún no hay referencias. Crea la primera con el botón de arriba.' }));
      return;
    }
    for (const r of refs) {
      list.append(el('div', { class: 'bg-white rounded-xl border border-slate-200 p-3 sm:p-4' }, [
        el('div', { class: 'flex items-center justify-between gap-2 mb-1' }, [
          el('div', { class: 'flex items-center gap-2 min-w-0' }, [
            el('span', { class: 'font-medium text-slate-900 truncate', text: r.name }),
            el('span', { class: 'text-xs text-slate-500', text: r.active ? 'activa' : 'inactiva' }),
          ]),
          el('button', {
            class: 'text-xs px-3 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700',
            onClick: () => editRef(r),
          }, ['Editar']),
        ]),
        el('div', { class: 'flex flex-wrap gap-1 text-xs' }, (r.varieties || []).map((v) =>
          el('span', { class: 'px-2 py-0.5 rounded-full bg-forest-light/15 text-forest-dark', text: v.name }),
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
    class: 'px-4 py-2 rounded-lg bg-forest hover:bg-forest-dark text-white',
    onClick: () => editRef(null),
  }, ['+ Nueva referencia']);

  render();

  return chrome(el('div', {}, [
    pageTitle('Referencias', 'Catálogo maestro y variedades vinculadas'),
    el('div', { class: 'mb-3 flex justify-end' }, [newBtn]),
    list,
  ]));
}

function openReferenceModal({ initial, allVarieties }) {
  return openModal(({ close }) => {
    const nameInput = el('input', {
      type: 'text', value: initial?.name || '',
      class: 'w-full px-3 py-2 rounded-lg border border-slate-300 focus:border-forest focus:ring-1 focus:ring-forest outline-none',
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
      class: 'w-full px-3 py-2 rounded-lg border border-slate-300 focus:border-forest focus:ring-1 focus:ring-forest outline-none',
      value: initial?.notes || '',
    });
    return el('div', { class: 'space-y-3' }, [
      el('label', { class: 'block text-sm font-medium text-slate-700' }, ['Nombre']),
      nameInput,
      el('label', { class: 'block text-sm font-medium text-slate-700 mt-2' }, ['Variedades']),
      vc.el,
      el('label', { class: 'block text-sm font-medium text-slate-700 mt-2' }, ['Notas']),
      notesInput,
      el('div', { class: 'flex justify-end gap-2 pt-2' }, [
        el('button', { class: 'px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          class: 'px-4 py-2 rounded-lg bg-forest hover:bg-forest-dark text-white',
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
