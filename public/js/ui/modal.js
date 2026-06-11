// Promise-based modal helpers using native <dialog>.
// CTRM-style header with eyebrow title.
import { el } from './el.js';

export function openModal(buildBody, { title = '', wide = false, size = null } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    // size='xl' para modales tipo tabla (despacho); wide para forms medianos.
    const sizeClass = size === 'xl' ? 'max-w-7xl'
                    : wide          ? 'max-w-2xl'
                    :                 'max-w-md';
    dialog.className = `bg-white text-slate-800 w-[96vw] ${sizeClass}`;

    let resolved = false;
    const close = (val) => {
      if (resolved) return;
      resolved = true;
      try { dialog.close(); } catch {}
      dialog.remove();
      resolve(val);
    };

    const header = el('div', { class: 'flex items-center justify-between px-5 py-3 border-b border-sand bg-cream' }, [
      el('h2', {
        class: 'eyebrow text-navy',
        text: title || ' ',
      }),
      el('button', {
        class: 'text-ink-500 hover:text-navy w-7 h-7 rounded-full flex items-center justify-center hover:bg-sand text-sm',
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
      el('p', { class: 'text-ink-700 mb-4 text-[13px] leading-relaxed', text: message }),
      el('div', { class: 'flex justify-end gap-2' }, [
        el('button', {
          class: 'ctrm-btn ctrm-btn-ghost',
          type: 'button', onClick: () => close(false),
        }, [cancelText]),
        el('button', {
          class: `ctrm-btn ${danger ? 'ctrm-btn-danger' : 'ctrm-btn-primary'}`,
          type: 'button', onClick: () => close(true),
        }, [confirmText]),
      ]),
    ]);
  }, { title });
}
