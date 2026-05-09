import { el } from './el.js';

const COLORS = {
  info:    'bg-slate-800 text-white',
  success: 'bg-emerald-700 text-white',
  warning: 'bg-amber-600 text-white',
  error:   'bg-rose-700 text-white',
};

export function toast(message, kind = 'info', ms = 3500) {
  const root = document.getElementById('toasts');
  if (!root) return;
  const node = el('div', {
    class: `pointer-events-auto px-4 py-2 rounded-lg shadow-lg max-w-md text-sm ${COLORS[kind] || COLORS.info}`,
    role: 'status',
  }, [message]);
  root.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 350);
  }, ms);
}
