// Tabla con headers clickeables para ordenar. Stateful: una vez
// renderizada, conserva el sort entre re-renders del padre porque
// devuelve un node + un método `rerender()` que reconstruye el
// <tbody> con el orden actual.
//
// Uso:
//   const t = sortableTable({
//     headers: [
//       { label: 'Bache',     sortGetter: (r) => r.bache_code },
//       { label: 'Días',      sortGetter: (r) => r.days, cls: 'text-right' },
//       { label: 'Humedad',   sortGetter: (r) => r.humidity, cls: 'text-right' },
//       { label: 'Acciones',  cls: 'text-right' },   // sin sortGetter = no ordenable
//     ],
//     items,
//     renderRow: (item) => el('tr', {}, [...]),
//     defaultSort: { index: 1, dir: 'desc' },   // opcional
//   });
//   container.append(t.el);
//
// El sort se evalúa con localeCompare(es) para strings y comparación
// numérica/temporal para el resto. nulls van al final siempre.

import { el } from './el.js';

export function sortableTable({ headers, items, renderRow, defaultSort = null, wrapClass = 'overflow-x-auto ctrm-card' }) {
  let _sort = defaultSort;  // { index, dir } | null

  const tbody = el('tbody', {});
  const thead = el('thead', {});
  const table = el('table', { class: 'w-full text-[12px] responsive-stack' }, [thead, tbody]);
  const wrap  = el('div', { class: wrapClass }, [table]);

  function sortedItems() {
    if (!_sort) return items.slice();
    const h = headers[_sort.index];
    if (!h || !h.sortGetter) return items.slice();
    const getter = h.sortGetter;
    const dir = _sort.dir === 'desc' ? -1 : 1;
    return items.slice().sort((a, b) => {
      const av = getter(a);
      const bv = getter(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string' && typeof bv === 'string') {
        return av.localeCompare(bv, 'es', { sensitivity: 'base' }) * dir;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  function renderHead() {
    thead.innerHTML = '';
    const tr = el('tr', {});
    headers.forEach((h, idx) => {
      if (!h.sortGetter) {
        tr.append(el('th', { class: h.cls || '' }, [h.label]));
        return;
      }
      const active = _sort && _sort.index === idx;
      const arrow  = active ? (_sort.dir === 'asc' ? '↑' : '↓') : '↕';
      const arrowCls = active ? 'text-navy' : 'text-ink-300';
      const th = el('th', { class: h.cls || '' }, [
        el('button', {
          type: 'button',
          class: 'inline-flex items-center gap-1 hover:text-navy text-left w-full',
          style: 'background:none;border:none;padding:0;font:inherit;color:inherit;cursor:pointer;',
          onClick: () => {
            if (_sort && _sort.index === idx) {
              _sort = { index: idx, dir: _sort.dir === 'asc' ? 'desc' : 'asc' };
            } else {
              _sort = { index: idx, dir: 'asc' };
            }
            renderHead();
            renderBody();
          },
        }, [
          el('span', { text: h.label }),
          el('span', { class: `${arrowCls} text-[10px]`, text: arrow }),
        ]),
      ]);
      tr.append(th);
    });
    thead.append(tr);
  }

  function renderBody() {
    tbody.innerHTML = '';
    for (const row of sortedItems()) {
      const node = renderRow(row);
      if (node) tbody.append(node);
    }
  }

  renderHead();
  renderBody();

  return { el: wrap, table, thead, tbody, rerender: () => { renderHead(); renderBody(); } };
}
