import { el } from './el.js';

const COLORS = {
  info:    'bg-navy-dark text-white',
  success: 'bg-ok text-white',
  warning: 'bg-warn text-white',
  error:   'bg-crit text-white',
};

export function toast(message, kind = 'info', ms = 3500) {
  const root = document.getElementById('toasts');
  if (!root) return;
  const node = el('div', {
    class: `pointer-events-auto px-4 py-2 rounded-lg shadow-card-2 max-w-md text-[12px] font-medium tracking-loose ${COLORS[kind] || COLORS.info}`,
    role: 'status',
  }, [message]);
  root.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 350);
  }, ms);
}
