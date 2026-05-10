// Single-select combobox with type-to-search and a pinned "+ Crear nueva" footer.
// Used for the reference picker in the demand form.
//
// Usage:
//   const cb = createCombobox({
//     placeholder: 'Buscar referencia...',
//     items: [{id, name}], value: null,
//     onChange: (item) => {...},
//     onCreate: async (text) => returns the new item, e.g. { id, name }
//   });
//   container.append(cb.el);
//
import { el } from './el.js';

export function createCombobox({
  placeholder = 'Buscar...',
  items = [],
  value = null,
  onChange = () => {},
  onCreate = null,
  createLabel = '+ Crear nueva',
  emptyText = 'Sin resultados',
}) {
  let _items = items;
  let _value = value;
  let _open = false;
  let _filter = '';
  let _activeIdx = -1;

  const input = el('input', {
    type: 'text',
    placeholder,
    class: 'ctrm-input',
    autocomplete: 'off',
  });
  const list = el('div', {
    class: 'absolute left-0 right-0 mt-1 bg-white border border-sand rounded-lg shadow-card-2 max-h-64 overflow-auto z-20 hidden',
    role: 'listbox',
  });
  const wrap = el('div', { class: 'relative' }, [input, list]);

  function setValue(item) {
    _value = item;
    input.value = item ? item.name : '';
    onChange(item);
  }

  function filteredItems() {
    const q = _filter.trim().toLowerCase();
    if (!q) return _items;
    return _items.filter((i) => i.name.toLowerCase().includes(q));
  }

  function render() {
    list.innerHTML = '';
    const f = filteredItems();
    if (f.length === 0) {
      list.append(el('div', { class: 'px-3 py-2 text-[12px] text-ink-500', text: emptyText }));
    } else {
      f.forEach((item, i) => {
        const row = el('div', {
          class: `px-3 py-2 text-[13px] cursor-pointer ${i === _activeIdx ? 'bg-navy text-white' : 'hover:bg-cream'}`,
          role: 'option',
          onClick: () => { setValue(item); close(); },
        }, [item.name]);
        list.append(row);
      });
    }
    if (onCreate) {
      const showCreate = _filter.trim() && !_items.some((i) => i.name.toLowerCase() === _filter.trim().toLowerCase());
      list.append(el('div', {
        class: `px-3 py-2 text-[12px] border-t border-sand cursor-pointer font-medium ${showCreate ? 'bg-yellow-light text-warn hover:bg-yellow' : 'text-ink-500 hover:bg-cream'}`,
        // mousedown fires before the document-level mousedown that closes the list,
        // so the create handler always runs even when the click would also close.
        onMouseDown: async (e) => {
          e.preventDefault();
          const text = _filter.trim();
          try {
            const newItem = await onCreate(text);
            if (newItem) {
              _items = [..._items, newItem].sort((a, b) => a.name.localeCompare(b.name));
              setValue(newItem);
              close();
            }
          } catch (err) {
            // upstream should toast; do nothing here
          }
        },
      }, [showCreate ? `${createLabel}: "${_filter.trim()}"` : createLabel]));
    }
  }

  function open() { _open = true; list.classList.remove('hidden'); render(); }
  function close() { _open = false; list.classList.add('hidden'); _activeIdx = -1; }

  input.addEventListener('focus', open);
  input.addEventListener('input', () => {
    _filter = input.value;
    if (!_open) open();
    _activeIdx = -1;
    render();
  });
  input.addEventListener('keydown', (e) => {
    const f = filteredItems();
    if (e.key === 'ArrowDown') { e.preventDefault(); _activeIdx = Math.min(_activeIdx + 1, f.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _activeIdx = Math.max(_activeIdx - 1, 0); render(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (_activeIdx >= 0 && f[_activeIdx]) { setValue(f[_activeIdx]); close(); }
    } else if (e.key === 'Escape') { close(); }
  });
  document.addEventListener('mousedown', (e) => {
    if (!wrap.contains(e.target)) close();
  });

  if (_value) input.value = _value.name;

  return {
    el: wrap,
    setItems(items) { _items = items; if (_open) render(); },
    setValue,
    getValue: () => _value,
    clear: () => { setValue(null); input.value = ''; _filter = ''; },
  };
}

// Multi-select tag combobox for varieties. Returns { el, getValues, setValues, setItems }.
export function createMultiCombobox({
  placeholder = 'Agregar...',
  items = [],
  values = [],          // array of {id, name}
  onChange = () => {},
  onCreate = null,
  createLabel = '+ Crear nueva',
}) {
  let _items = items;
  let _values = [...values];
  let _filter = '';

  const tagsRow = el('div', { class: 'flex flex-wrap gap-1.5 mb-2' });
  const input = el('input', {
    type: 'text',
    placeholder,
    class: 'ctrm-input',
    autocomplete: 'off',
  });
  const list = el('div', {
    class: 'absolute left-0 right-0 mt-1 bg-white border border-sand rounded-lg shadow-card-2 max-h-64 overflow-auto z-20 hidden',
  });
  const inputWrap = el('div', { class: 'relative' }, [input, list]);
  const wrap = el('div', {}, [tagsRow, inputWrap]);

  function notify() { onChange(_values); }

  function renderTags() {
    tagsRow.innerHTML = '';
    if (_values.length === 0) {
      tagsRow.append(el('span', { class: 'text-[11px] text-ink-300 italic', text: 'Ninguna seleccionada' }));
      return;
    }
    for (const v of _values) {
      tagsRow.append(el('span', {
        class: 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-navy text-yellow text-[11px] font-mono',
      }, [
        v.name,
        el('button', {
          class: 'text-yellow/70 hover:text-white text-[14px] leading-none',
          type: 'button',
          onClick: () => { _values = _values.filter((x) => x.id !== v.id); renderTags(); notify(); },
        }, ['×']),
      ]));
    }
  }

  function filteredItems() {
    const q = _filter.trim().toLowerCase();
    const selectedIds = new Set(_values.map((v) => v.id));
    let pool = _items.filter((i) => !selectedIds.has(i.id));
    if (q) pool = pool.filter((i) => i.name.toLowerCase().includes(q));
    return pool;
  }

  function renderList() {
    list.innerHTML = '';
    const f = filteredItems();
    if (f.length === 0 && !onCreate) {
      list.append(el('div', { class: 'px-3 py-2 text-[12px] text-ink-500', text: 'Sin resultados' }));
    }
    f.forEach((item) => {
      list.append(el('div', {
        class: 'px-3 py-2 text-[13px] cursor-pointer hover:bg-cream',
        onClick: () => { _values = [..._values, item]; renderTags(); notify(); _filter = ''; input.value = ''; renderList(); },
      }, [item.name]));
    });
    if (onCreate) {
      const text = _filter.trim();
      const showCreate = text && !_items.some((i) => i.name.toLowerCase() === text.toLowerCase());
      list.append(el('div', {
        class: `px-3 py-2 text-[12px] border-t border-sand cursor-pointer font-medium ${showCreate ? 'bg-yellow-light text-warn hover:bg-yellow' : 'text-ink-500 hover:bg-cream'}`,
        onMouseDown: async (e) => {
          e.preventDefault();
          const newItem = await onCreate(text);
          if (newItem) {
            _items = [..._items, newItem].sort((a, b) => a.name.localeCompare(b.name));
            _values = [..._values, newItem];
            renderTags(); notify();
            _filter = ''; input.value = ''; renderList();
          }
        },
      }, [showCreate ? `${createLabel}: "${text}"` : createLabel]));
    }
  }

  input.addEventListener('focus', () => { list.classList.remove('hidden'); renderList(); });
  input.addEventListener('input', () => { _filter = input.value; renderList(); });
  document.addEventListener('mousedown', (e) => {
    if (!wrap.contains(e.target)) list.classList.add('hidden');
  });

  renderTags();

  return {
    el: wrap,
    setItems(items) { _items = items; renderList(); },
    setValues(values) { _values = [...values]; renderTags(); notify(); },
    getValues: () => _values,
  };
}
