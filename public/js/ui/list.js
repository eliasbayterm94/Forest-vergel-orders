// Reusable card-list component: filters + sort + totals + pagination.
//
// Card lists in this app aren't <table> elements — they stack ctrm-cards
// vertically. This helper wraps any such list in:
//   - a filter bar (selects + free-text search)
//   - a totals strip (computed on the *filtered* set, not just the page)
//   - a sort dropdown
//   - the actual list of cards (paged to pageSize, default 20)
//   - a pagination footer (prev / next / "Página X de Y · N items")
//
// Usage:
//   const view = listView({
//     items: orders,
//     renderItem: (o) => orderRow(o),
//     pageSize: 20,
//     emptyText: 'Sin pedidos.',
//     searchPlaceholder: 'Buscar código, cliente, contrato...',
//     searchMatch: (o, q) => {
//       const lo = q.toLowerCase();
//       return [o.order_code, o.client_name, o.contract_code, o.reference_name]
//         .some((s) => (s || '').toLowerCase().includes(lo));
//     },
//     filters: [
//       { key: 'status', label: 'Estado',
//         options: ['Pending','Accepted','Completed'],
//         optionLabels: { Pending: 'Pendiente', Accepted: 'Aceptado' },
//         getter: (o) => o.status },
//     ],
//     sorts: [
//       { key: 'date_asc', label: 'Entrega: más cercana',
//         getter: (o) => o.max_delivery_date, dir: 'asc' },
//       { key: 'kg_desc',  label: 'Mayor kg verde',
//         getter: (o) => Number(o.kg_green_required||0), dir: 'desc' },
//     ],
//     defaultSort: 'date_asc',
//     totals: [
//       { label: 'Pedidos',  value: (arr) => String(arr.length) },
//       { label: 'kg verde', value: (arr) => fmtKg(sum(arr, 'kg_green_required')) },
//     ],
//   });

import { el, clear } from './el.js';
import { renderFilterButton } from './filters-sheet.js';
import { createViewMode } from './view-mode.js';

export function listView(opts) {
  const {
    items = [],
    renderItem,
    // Si se pasan tableHeaders + tableRow, listView renderiza como
    // tabla cuando vm.mode === 'table'. viewModeKey activa el toggle.
    tableHeaders = null,
    tableRow = null,
    viewModeKey = null,
    pageSize = 20,
    emptyText = 'Sin elementos.',
    searchPlaceholder = 'Buscar...',
    searchMatch = null,
    filters = [],
    sorts = [],
    defaultSort = null,
    totals = [],
  } = opts;

  // --- Internal state (closure) -----------------------------------
  const _filterValues = {};
  let _query = '';
  let _sortKey = defaultSort || (sorts[0] && sorts[0].key) || null;
  // Column sort takes precedence over _sortKey when active. Click en el
  // mismo header alterna asc/desc; click en otro header lo resetea.
  let _columnSort = null;  // { index, dir: 'asc'|'desc' }
  let _page = 0;

  // View mode toggle si el caller paso renderers de tabla + un key.
  const vm = (viewModeKey && tableHeaders && tableRow)
    ? createViewMode(viewModeKey, { onChange: () => rerender() })
    : null;

  // --- DOM scaffolding --------------------------------------------
  const root = el('div', { class: 'space-y-3' });

  const hasFilterControls = filters.length > 0 || !!searchMatch || sorts.length > 0 || vm;
  const filterBar = el('div', { class: 'flex flex-wrap items-center gap-2' });
  if (hasFilterControls) root.append(filterBar);

  const totalsStrip = el('div', { class: 'grid grid-cols-2 sm:grid-cols-4 gap-2' });
  if (totals.length > 0) root.append(totalsStrip);

  const listContent = el('div', { class: 'space-y-2' });
  root.append(listContent);

  const paginationFooter = el('div', { class: 'flex flex-wrap items-center justify-between gap-2 mt-1 pt-2' });
  root.append(paginationFooter);

  // --- Apply filters / search / sort / page -----------------------
  function compute() {
    let filtered = items.slice();
    for (const f of filters) {
      const v = _filterValues[f.key];
      if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
      if (Array.isArray(v)) {
        filtered = filtered.filter((it) => v.includes(f.getter(it)));
      } else {
        filtered = filtered.filter((it) => f.getter(it) === v);
      }
    }
    if (searchMatch && _query.trim()) {
      const q = _query.trim();
      filtered = filtered.filter((it) => searchMatch(it, q));
    }

    let sorted = filtered.slice();
    // Active sorter: el column-sort (click en header) gana sobre el
    // dropdown global; si no hay column-sort cae al sort por defecto.
    let activeGetter = null;
    let activeDir = 'asc';
    if (_columnSort && tableHeaders) {
      const h = tableHeaders[_columnSort.index];
      if (h && h.sortGetter) {
        activeGetter = h.sortGetter;
        activeDir = _columnSort.dir;
      }
    }
    if (!activeGetter) {
      const sortDef = sorts.find((s) => s.key === _sortKey);
      if (sortDef) {
        activeGetter = sortDef.getter;
        activeDir = sortDef.dir || 'asc';
      }
    }
    if (activeGetter) {
      const dir = activeDir === 'desc' ? -1 : 1;
      sorted.sort((a, b) => {
        const av = activeGetter(a);
        const bv = activeGetter(b);
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        // Comparación case-insensitive para strings.
        if (typeof av === 'string' && typeof bv === 'string') {
          const cmp = av.localeCompare(bv, 'es', { sensitivity: 'base' });
          return cmp * dir;
        }
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }

    const totalCount = sorted.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    if (_page >= totalPages) _page = totalPages - 1;
    if (_page < 0) _page = 0;
    const paged = sorted.slice(_page * pageSize, (_page + 1) * pageSize);
    return { paged, filtered, totalCount, totalPages };
  }

  // --- Filter bar ------------------------------------------------
  function buildFilterBar() {
    clear(filterBar);
    if (!hasFilterControls) return;

    if (searchMatch) {
      const inp = el('input', {
        type: 'search',
        placeholder: searchPlaceholder,
        class: 'ctrm-input flex-1 min-w-[180px]',
        value: _query,
      });
      inp.addEventListener('input', () => {
        _query = inp.value;
        _page = 0;
        rerender();
      });
      filterBar.append(inp);
    }

    if (filters.length > 0) {
      const fb = renderFilterButton({
        filters,
        values: _filterValues,
        onChange: (newValues) => {
          _filterValues = newValues;
          _page = 0;
          rerender();
        },
      });
      filterBar.append(fb.el);
    }

    if (sorts.length > 0) {
      const sortSel = el('select', { class: 'ctrm-select' },
        sorts.map((s) => el('option', { value: s.key, selected: _sortKey === s.key }, [`Orden: ${s.label}`])),
      );
      sortSel.addEventListener('change', () => { _sortKey = sortSel.value; rerender(); });
      filterBar.append(sortSel);
    }

    if (vm) {
      filterBar.append(vm.toggleEl);
    }

    if (filters.length > 0 || searchMatch) {
      const reset = el('button', {
        class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
        type: 'button',
        onClick: () => {
          for (const f of filters) delete _filterValues[f.key];
          _query = '';
          _page = 0;
          buildFilterBar();
          rerender();
        },
      }, ['Limpiar']);
      filterBar.append(reset);
    }
  }

  // --- Re-render dynamic regions ---------------------------------
  function rerender() {
    const { paged, filtered, totalCount, totalPages } = compute();

    // Totals
    if (totals.length > 0) {
      clear(totalsStrip);
      for (const t of totals) {
        totalsStrip.append(el('div', { class: 'rounded-lg bg-cream border border-sand p-3' }, [
          el('p', { class: 'eyebrow mb-1', text: t.label }),
          el('p', { class: 'font-display font-bold text-navy text-[15px]', text: t.value(filtered) }),
        ]));
      }
    }

    // List content
    clear(listContent);
    if (paged.length === 0) {
      // emptyText puede ser un string (renderiza italic gris) o ya un Node
      // (e.g. emptyStateCard con CTA).
      if (emptyText instanceof Node) {
        listContent.append(emptyText);
      } else if (typeof emptyText === 'function') {
        const node = emptyText();
        if (node) listContent.append(node);
      } else {
        listContent.append(el('p', { class: 'text-[12px] text-ink-300 italic px-1', text: String(emptyText) }));
      }
    } else if (vm && vm.mode() === 'table' && tableHeaders && tableRow) {
      // Table mode
      const wrap = el('div', { class: 'overflow-x-auto ctrm-card' });
      const hasTotals = tableHeaders.some((h) => typeof h.total === 'function');
      // Los totales se computan sobre el filtered set completo, no sobre la página visible.
      const footer = hasTotals && filtered.length > 0
        ? el('tfoot', {}, [el('tr', { class: 'border-t-2 border-ink-300 bg-cream' },
            tableHeaders.map((h) => {
              const td = el('td', { class: `${h.cls || ''} px-2 py-2 ${h.totalCls || 'font-mono font-semibold'}` });
              td.setAttribute('data-label', h.label);
              if (typeof h.total === 'function') {
                const v = h.total(filtered);
                if (v instanceof Node) td.append(v);
                else td.append(document.createTextNode(String(v == null ? '' : v)));
              }
              return td;
            }))])
        : null;
      const t = el('table', { class: 'w-full text-[12px] responsive-stack' }, [
        el('thead', {}, [el('tr', {}, tableHeaders.map((h, idx) => {
          if (!h.sortGetter) return el('th', { class: h.cls || '' }, [h.label]);
          const isActive = _columnSort && _columnSort.index === idx;
          const arrow = isActive ? (_columnSort.dir === 'asc' ? '↑' : '↓') : '↕';
          const arrowClass = isActive ? 'text-navy' : 'text-ink-300';
          return el('th', { class: h.cls || '' }, [
            el('button', {
              type: 'button',
              class: 'inline-flex items-center gap-1 hover:text-navy text-left w-full',
              style: 'background:none;border:none;padding:0;font:inherit;color:inherit;cursor:pointer;',
              onClick: () => {
                if (_columnSort && _columnSort.index === idx) {
                  _columnSort = { index: idx, dir: _columnSort.dir === 'asc' ? 'desc' : 'asc' };
                } else {
                  _columnSort = { index: idx, dir: 'asc' };
                }
                _page = 0;
                rerender();
              },
            }, [
              el('span', { text: h.label }),
              el('span', { class: `${arrowClass} text-[10px]`, text: arrow }),
            ]),
          ]);
        }))]),
        el('tbody', {}, paged.map((item) => tableRow(item)).filter(Boolean)),
        footer,
      ]);
      wrap.append(t);
      listContent.append(wrap);
    } else {
      for (const item of paged) {
        const node = renderItem(item);
        if (node) listContent.append(node);
      }
    }

    // Pagination footer
    clear(paginationFooter);
    if (totalCount > pageSize) {
      paginationFooter.append(
        el('p', { class: 'text-[11px] text-ink-500 font-mono' }, [
          `Página ${_page + 1} de ${totalPages}  ·  ${totalCount} items`,
        ]),
        el('div', { class: 'flex items-center gap-2' }, [
          el('button', {
            class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
            disabled: _page === 0,
            type: 'button',
            onClick: () => { _page--; rerender(); },
          }, ['‹ Anterior']),
          el('button', {
            class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
            disabled: _page >= totalPages - 1,
            type: 'button',
            onClick: () => { _page++; rerender(); },
          }, ['Siguiente ›']),
        ]),
      );
    } else if (totalCount > 0 && (filters.length > 0 || searchMatch)) {
      // When filters are active but everything fits on one page, still show the count for context.
      paginationFooter.append(el('p', { class: 'text-[11px] text-ink-500 font-mono' }, [`${totalCount} items`]));
    }
  }

  buildFilterBar();
  rerender();
  return root;
}

// Small utility used by view files.
export const sumOf = (arr, key) => arr.reduce((s, x) => s + Number(x[key] || 0), 0);
