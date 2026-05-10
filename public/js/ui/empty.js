// Empty state action-oriented. Reemplaza el "texto italic gris" con
// un mini-card que invita a la siguiente accion logica.

import { el } from './el.js';

/**
 * emptyStateCard({ title, description?, action?: { label, onClick } })
 */
export function emptyStateCard({ title, description, action } = {}) {
  return el('div', {
    class: 'ctrm-card ctrm-card-pad text-center',
  }, [
    el('p', { class: 'eyebrow text-ink-300 mb-1', text: title || 'Sin datos' }),
    description
      ? el('p', { class: 'text-[12px] text-ink-500 leading-snug mb-2', text: description })
      : null,
    action ? el('button', {
      class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm mt-1',
      type: 'button',
      onClick: action.onClick,
    }, [action.label]) : null,
  ]);
}

/**
 * emptyText: backwards-compatible texto plano para los lugares donde
 * no hay accion logica que sugerir.
 */
export function emptyText(text) {
  return el('p', {
    class: 'text-[12px] text-ink-300 italic px-1',
    text,
  });
}
