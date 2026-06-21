// Anchored popover — mini surface that floats next to a trigger
// element (typically a small ⓘ button) without navigating away
// from the page. Used by Cola de Pedidos to show the "solicitud
// original" (aspecto, intensidad, comentario de Forest) on
// demand.
//
// Usage:
//   import { openPopover } from '../ui/popover.js';
//   button.addEventListener('click', (e) => {
//     openPopover({
//       anchor: e.currentTarget,
//       title: 'Solicitud del pedido',
//       subtitle: 'PED-2026-0042',
//       body: el('div', {}, [...]),
//     });
//   });
//
// Auto-close on: outside click, ESC, scroll, or window resize.
// Only one popover can be open at a time.

import { el } from './el.js';

let openInstance = null;

function destroy() {
  if (!openInstance) return;
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onEsc);
  window.removeEventListener('scroll', destroy, true);
  window.removeEventListener('resize', destroy);
  openInstance.remove();
  openInstance = null;
}

function onOutside(e) {
  if (!openInstance) return;
  if (openInstance.contains(e.target)) return;
  if (openInstance._anchor && openInstance._anchor.contains(e.target)) return;
  destroy();
}

function onEsc(e) {
  if (e.key === 'Escape') destroy();
}

// Positions the popover near the anchor: prefers below; flips above
// when there's not enough room. Clamps horizontally to the viewport.
function position(pop, anchor) {
  const r  = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const m  = 6;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top  = r.bottom + m;
  let left = r.left;
  if (top + pr.height > vh - 8 && r.top > pr.height + m) {
    top = r.top - pr.height - m;
  }
  if (left + pr.width > vw - 8) left = vw - pr.width - 8;
  if (left < 8) left = 8;
  pop.style.top  = `${top}px`;
  pop.style.left = `${left}px`;
}

export function openPopover({ anchor, title, subtitle, body, width }) {
  destroy(); // close any prior instance
  if (!anchor) return null;

  const closeBtn = el('button', {
    type: 'button',
    class: 'absolute top-1.5 right-1.5 text-ink-300 hover:text-navy text-[18px] leading-none px-1',
    title: 'Cerrar (Esc)',
    onClick: destroy,
  }, ['×']);

  const head = (title || subtitle) ? el('div', {
    class: 'px-3 pt-2.5 pb-2 border-b border-sand pr-7',
  }, [
    title    ? el('p', { class: 'eyebrow text-[9px] text-ink-500 mb-0.5', text: title }) : null,
    subtitle ? el('p', { class: 'font-mono text-[11px] text-navy font-semibold', text: subtitle }) : null,
  ]) : null;

  const pop = el('div', {
    class: 'relative bg-white border border-sand rounded-lg shadow-xl',
    style: `position:fixed;z-index:1000;width:${width || 300}px;max-width:calc(100vw - 16px);`,
  }, [
    head,
    closeBtn,
    el('div', { class: 'px-3 py-2.5' }, [body]),
  ]);
  pop._anchor = anchor;
  document.body.append(pop);
  openInstance = pop;
  position(pop, anchor);

  // Defer adding listeners so the triggering click doesn't immediately close us.
  setTimeout(() => {
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onEsc);
    window.addEventListener('scroll', destroy, true);
    window.addEventListener('resize', destroy);
  }, 0);

  return { close: destroy };
}

export const closePopover = destroy;
