// Promise-based modal helpers using native <dialog>.
// openModal(buildBody) → resolves with whatever you call resolve(value) with.
import { el } from './el.js';

export function openModal(buildBody, { title = '', wide = false } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = `bg-white text-slate-800 ${wide ? 'w-[92vw] max-w-2xl' : 'w-[92vw] max-w-md'}`;

    let resolved = false;
    const close = (val) => {
      if (resolved) return;
      resolved = true;
      try { dialog.close(); } catch {}
      dialog.remove();
      resolve(val);
    };

    const header = el('div', { class: 'flex items-center justify-between px-5 py-3 border-b border-slate-200' }, [
      el('h2', { class: 'font-semibold text-slate-900', text: title || ' ' }),
      el('button', {
        class: 'text-slate-500 hover:text-slate-800 px-2 py-1 -mr-2',
        type: 'button',
        onClick: () => close(null),
        'aria-label': 'Cerrar',
      }, ['✕']),
    ]);

    const body = el('div', { class: 'px-5 py-4' });
    dialog.append(header, body);

    const built = buildBody({ close, body });
    if (built instanceof Node) body.append(built);

    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    document.body.append(dialog);
    dialog.showModal();
  });
}

// Confirmation dialog. Returns boolean.
export function confirmModal(message, { title = 'Confirmar', confirmText = 'Confirmar', cancelText = 'Cancelar', danger = false } = {}) {
  return openModal(({ close }) => {
    return el('div', {}, [
      el('p', { class: 'text-slate-700 mb-4', text: message }),
      el('div', { class: 'flex justify-end gap-2' }, [
        el('button', {
          class: 'px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700',
          type: 'button', onClick: () => close(false),
        }, [cancelText]),
        el('button', {
          class: `px-4 py-2 rounded-lg text-white ${danger ? 'bg-rose-700 hover:bg-rose-800' : 'bg-forest hover:bg-forest-dark'}`,
          type: 'button', onClick: () => close(true),
        }, [confirmText]),
      ]),
    ]);
  }, { title });
}
