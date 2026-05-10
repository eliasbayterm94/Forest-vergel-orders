// Filters como boton + bottom-sheet. Reemplaza los <select> inline.
//
// Uso:
//   const fb = renderFilterButton({ filters, values, onChange });
//   container.append(fb);
//   // values siempre es { [filterKey]: value | string[] }
//
// filters[i] shape:
//   {
//     key: 'process_type',
//     label: 'Proceso',
//     options: ['Natural', 'Honey', 'Lavado'],
//     optionLabels?: { Natural: 'Natural...' },
//     multi?: false,    // true = checkbox group, false = radio
//     icon?: null,      // reservado a futuro
//   }
//
// values:
//   { process_type: 'Natural' }     -- single
//   { client_name: ['Acme','GHC'] } -- multi
//
// onChange recibe el objeto values entero cuando el usuario aplica.

import { el } from './el.js';
import { openModal } from './modal.js';

export function renderFilterButton({ filters, values = {}, onChange }) {
  // Estado local; el wrapper se redibuja al volver del sheet.
  let current = clone(values);

  const wrap = el('div', { class: 'flex items-center gap-2 flex-wrap' });

  function activeCount() {
    let n = 0;
    for (const f of filters) {
      const v = current[f.key];
      if (v == null) continue;
      if (Array.isArray(v)) n += v.length;
      else if (v !== '') n += 1;
    }
    return n;
  }

  function redraw() {
    wrap.innerHTML = '';
    const n = activeCount();
    const btn = el('button', {
      type: 'button',
      class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm filter-btn',
      onClick: async () => {
        const result = await openFiltersSheet({ filters, values: current });
        if (result == null) return;
        current = result;
        if (typeof onChange === 'function') onChange(clone(current));
        redraw();
      },
    }, [
      filterIcon(),
      el('span', { text: 'Filtros' }),
      n > 0 ? el('span', { class: 'filter-btn-badge', text: String(n) }) : null,
    ]);
    wrap.append(btn);

    // Chips de valores activos al lado del boton
    for (const f of filters) {
      const v = current[f.key];
      if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
      const labelMap = f.optionLabels || {};
      const labels = Array.isArray(v) ? v.map((x) => labelMap[x] || x) : [labelMap[v] || v];
      for (const lab of labels) {
        wrap.append(el('span', {
          class: 'filter-active-chip',
          title: f.label,
        }, [
          el('span', { class: 'filter-active-chip-key', text: f.label }),
          el('span', { text: lab }),
          el('button', {
            type: 'button',
            class: 'filter-active-chip-x',
            'aria-label': 'Quitar filtro',
            onClick: () => {
              if (Array.isArray(v)) {
                current[f.key] = v.filter((x) => (labelMap[x] || x) !== lab);
                if (current[f.key].length === 0) delete current[f.key];
              } else {
                delete current[f.key];
              }
              if (typeof onChange === 'function') onChange(clone(current));
              redraw();
            },
          }, ['×']),
        ]));
      }
    }
  }
  redraw();

  return {
    el: wrap,
    setValues(v) { current = clone(v); redraw(); },
    getValues() { return clone(current); },
  };
}

export function openFiltersSheet({ filters, values = {} }) {
  return openModal(({ close }) => {
    // Estado interno hasta apply / clear.
    let draft = clone(values);
    // Acordeon: grupos con al menos un valor activo abiertos por default.
    const openGroups = new Set(filters
      .filter((f) => hasValue(draft[f.key]))
      .map((f) => f.key));
    if (openGroups.size === 0 && filters.length > 0) openGroups.add(filters[0].key);

    const body = el('div', { class: 'space-y-2' });

    function rerender() {
      body.innerHTML = '';
      body.append(el('div', { class: 'flex items-center justify-between mb-3' }, [
        el('p', { class: 'text-[12px] text-ink-500' }, ['Selecciona uno o varios criterios.']),
        el('button', {
          type: 'button',
          class: 'text-[12px] font-display font-semibold text-navy hover:underline',
          onClick: () => { draft = {}; rerender(); },
        }, ['Limpiar todo']),
      ]));
      for (const f of filters) body.append(renderGroup(f));
      body.append(el('div', { class: 'flex justify-end gap-2 pt-3 mt-2 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-primary',
          type: 'button',
          onClick: () => close(clone(draft)),
        }, ['Aplicar']),
      ]));
    }

    function renderGroup(f) {
      const isOpen = openGroups.has(f.key);
      const labelMap = f.optionLabels || {};

      const header = el('button', {
        type: 'button',
        class: 'filter-group-header',
        onClick: () => {
          if (isOpen) openGroups.delete(f.key); else openGroups.add(f.key);
          rerender();
        },
      }, [
        el('span', { class: 'filter-group-label', text: f.label }),
        el('span', { class: 'filter-group-chevron', text: isOpen ? '▾' : '▸' }),
      ]);

      let content = null;
      if (isOpen) {
        const items = f.options.map((opt) => {
          const checked = f.multi
            ? Array.isArray(draft[f.key]) && draft[f.key].includes(opt)
            : draft[f.key] === opt;
          const input = el('input', {
            type: f.multi ? 'checkbox' : 'radio',
            name: f.key,
            class: 'h-4 w-4 accent-navy shrink-0',
            checked,
            onChange: () => {
              if (f.multi) {
                const cur = Array.isArray(draft[f.key]) ? draft[f.key].slice() : [];
                if (cur.includes(opt)) {
                  draft[f.key] = cur.filter((x) => x !== opt);
                } else {
                  draft[f.key] = [...cur, opt];
                }
                if (draft[f.key].length === 0) delete draft[f.key];
              } else {
                if (draft[f.key] === opt) delete draft[f.key];
                else draft[f.key] = opt;
              }
              rerender();
            },
          });
          return el('label', { class: 'filter-option' }, [
            input,
            el('span', { class: 'filter-option-label', text: labelMap[opt] || opt }),
          ]);
        });
        content = el('div', { class: 'filter-group-body' }, items);
      }

      return el('div', { class: `filter-group ${isOpen ? 'is-open' : ''}` }, [header, content]);
    }

    rerender();
    return body;
  }, { title: 'Filtros', wide: true });
}

// ─── Helpers ───────────────────────────────────────────────────────
function clone(o) {
  // shallow + arrays
  const out = {};
  for (const [k, v] of Object.entries(o || {})) {
    out[k] = Array.isArray(v) ? v.slice() : v;
  }
  return out;
}

function hasValue(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  return v !== '';
}

function filterIcon() {
  const span = document.createElement('span');
  span.className = 'inline-flex';
  span.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>`;
  return span;
}
