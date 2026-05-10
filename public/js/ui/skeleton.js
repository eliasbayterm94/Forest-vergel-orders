// Skeleton placeholder durante la carga de un view. Se monta sync
// inmediatamente al entrar a la ruta y se reemplaza cuando el view
// termina de hacer fetch + render.

import { el } from './el.js';

export function skeletonView() {
  return el('div', { class: 'skeleton-view' }, [
    el('div', { class: 'skeleton-title' }),
    el('div', { class: 'skeleton-stat-row' }, [
      el('div', { class: 'skeleton-stat' }),
      el('div', { class: 'skeleton-stat' }),
      el('div', { class: 'skeleton-stat' }),
      el('div', { class: 'skeleton-stat' }),
    ]),
    el('div', { class: 'skeleton-block' }),
    el('div', { class: 'skeleton-block' }),
    el('div', { class: 'skeleton-block tall' }),
  ]);
}
