import { el } from './el.js';

const COLORS = {
  info:    'bg-navy-dark text-white',
  success: 'bg-ok text-white',
  warning: 'bg-warn text-white',
  error:   'bg-crit text-white',
};

/**
 * toast(message, kind, ms, opts?)
 *   message  - texto a mostrar
 *   kind     - 'info' | 'success' | 'warning' | 'error'
 *   ms       - duracion en ms (default 3500). 0 = no auto-dismiss.
 *   opts     - { action: { label, onClick } } para boton tipo "Deshacer"
 *
 * Si pasas action, el toast queda mas tiempo (8s default) y al click
 * se invoca onClick + se cierra el toast inmediatamente.
 */
export function toast(message, kind = 'info', ms = 3500, opts = {}) {
  const root = document.getElementById('toasts');
  if (!root) return;

  const hasAction = opts && opts.action && typeof opts.action.onClick === 'function';
  const duration = ms === 0 ? null : (hasAction && ms === 3500 ? 8000 : ms);

  const node = el('div', {
    class: `pointer-events-auto px-4 py-2 rounded-lg shadow-card-2 max-w-md text-[12px] font-medium tracking-loose flex items-center gap-3 ${COLORS[kind] || COLORS.info}`,
    role: 'status',
  }, [
    el('span', { class: 'flex-1' }, [message]),
    hasAction
      ? el('button', {
          type: 'button',
          class: 'shrink-0 px-2 py-1 -my-1 rounded uppercase tracking-eyebrow text-[10px] font-bold bg-white/20 hover:bg-white/30',
          onClick: () => {
            try { opts.action.onClick(); } catch (e) { /* no-op */ }
            close();
          },
        }, [opts.action.label || 'Deshacer'])
      : null,
  ]);
  root.appendChild(node);

  function close() {
    node.style.transition = 'opacity .3s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 350);
  }
  if (duration != null) setTimeout(close, duration);
}
