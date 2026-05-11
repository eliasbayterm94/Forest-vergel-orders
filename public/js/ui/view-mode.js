// Toggle "Tabla / Cards" reusable. Persiste preferencia por-vista en
// localStorage. Default: tabla en desktop, cards en mobile.
//
// Uso:
//   const vm = createViewMode('cola', { onChange: redraw });
//   container.append(vm.toggleEl);
//   if (vm.mode() === 'table') render as table else render as cards.

import { el } from './el.js';

const STORAGE_PREFIX = 'fv:viewMode:';

export function createViewMode(viewKey, { onChange = () => {} } = {}) {
  const key = STORAGE_PREFIX + viewKey;
  const stored = safeGet(key);
  let mode = stored === 'table' || stored === 'cards' ? stored : defaultMode();

  const tableBtn = btn('Tabla', 'table');
  const cardsBtn = btn('Cards', 'cards');

  function btn(label, value) {
    return el('button', {
      type: 'button',
      'data-mode': value,
      class: 'view-mode-btn',
      onClick: () => {
        if (mode === value) return;
        mode = value;
        safeSet(key, value);
        refresh();
        onChange(mode);
      },
    }, [label]);
  }

  function refresh() {
    for (const b of [tableBtn, cardsBtn]) {
      const v = b.getAttribute('data-mode');
      b.classList.toggle('is-active', v === mode);
    }
  }
  refresh();

  const toggleEl = el('div', {
    class: 'view-mode-toggle',
    role: 'group',
    'aria-label': 'Modo de vista',
  }, [tableBtn, cardsBtn]);

  return {
    toggleEl,
    mode: () => mode,
  };
}

function defaultMode() {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(max-width: 640px)').matches ? 'cards' : 'table';
  }
  return 'table';
}

function safeGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* no-op */ }
}
