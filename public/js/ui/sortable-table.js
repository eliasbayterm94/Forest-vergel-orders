// Tabla con headers clickeables para ordenar y, opcionalmente, una
// fila de totales en tfoot.
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
//     defaultSort: { index: 1, dir: 'desc' },
//     // Totales opcionales: array alineado con headers; cada slot es
//     // null (sin total para esa columna) o un objeto:
//     //   { value: (items) => string|Node, cls?: string, label?: string }
//     // El primer label no nulo se usa como rótulo "Total".
//     totals: [
//       { label: 'Total', value: () => 'Total', cls: 'font-semibold text-ink-700' },
//       null,
//       { value: (arr) => fmtKg(sum(arr, 'kg_seco')), cls: 'text-right font-mono' },
//     ],
//   });

import { el } from './el.js';

export function sortableTable({
  headers, items, renderRow,
  defaultSort = null,
  wrapClass = 'overflow-x-auto ctrm-card',
  totals = null,
}) {
  let _sort = defaultSort;  // { index, dir } | null

  const tbody = el('tbody', {});
  const thead = el('thead', {});
  const tfoot = totals ? el('tfoot', {}) : null;
  const table = el('table', { class: 'w-full text-[12px] responsive-stack' },
    tfoot ? [thead, tbody, tfoot] : [thead, tbody]);
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

  function renderFoot() {
    if (!tfoot) return;
    tfoot.innerHTML = '';
    if (items.length === 0) return;
    const tr = el('tr', { class: 'border-t-2 border-ink-300 bg-cream' });
    headers.forEach((h, idx) => {
      const tdef = totals[idx];
      if (!tdef) {
        tr.append(el('td', { class: `${h.cls || ''} px-2 py-2` }, []));
        return;
      }
      let v = tdef.value ? tdef.value(items) : '';
      const td = el('td', { class: `${tdef.cls || h.cls || ''} px-2 py-2` });
      td.setAttribute('data-label', h.label);
      if (v instanceof Node) td.append(v);
      else td.append(document.createTextNode(String(v == null ? '' : v)));
      tr.append(td);
    });
    tfoot.append(tr);
  }

  renderHead();
  renderBody();
  renderFoot();

  return {
    el: wrap, table, thead, tbody, tfoot,
    rerender: () => { renderHead(); renderBody(); renderFoot(); },
  };
}
