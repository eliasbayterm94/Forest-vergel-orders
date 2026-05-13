// Kebab dropdown menu para acciones secundarias en filas de tabla
// (o cualquier lugar donde el espacio sea limitado).
//
// Uso:
//   actionMenu([
//     { label: 'Editar', onClick: () => ... },
//     { label: 'Eliminar', onClick: () => ..., danger: true },
//     { label: 'Oculto', hidden: true },
//   ])
//
// Retorna el botón "⋮". Al hacer click se monta el menú en document.body
// con position:fixed para evitar problemas de overflow del contenedor.

import { el } from './el.js';

export function actionMenu(items, opts = {}) {
  const visible = (items || []).filter((i) => i && !i.hidden);
  if (visible.length === 0) return null;

  const width = opts.width || 180;
  const label = opts.label || '⋮';
  const title = opts.title || 'Más acciones';

  let menu = null;

  const close = () => {
    if (!menu) return;
    menu.remove();
    menu = null;
    document.removeEventListener('click',   onOutside, true);
    document.removeEventListener('keydown', onEsc,     true);
    window.removeEventListener('scroll',    close,     true);
    window.removeEventListener('resize',    close,     true);
  };

  const onOutside = (e) => {
    if (!menu) return;
    if (menu.contains(e.target) || btn.contains(e.target)) return;
    close();
  };
  const onEsc = (e) => { if (e.key === 'Escape') close(); };

  const btn = el('button', {
    type: 'button',
    class: 'ctrm-btn ctrm-btn-soft ctrm-btn-xs',
    title,
    'aria-haspopup': 'menu',
    onClick: (e) => {
      e.stopPropagation();
      if (menu) { close(); return; }
      const r = btn.getBoundingClientRect();
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width));
      const top  = r.bottom + 4;
      menu = el('div', {
        class: 'bg-cream border border-sand rounded-md shadow-lg',
        role: 'menu',
        style: `position:fixed; top:${top}px; left:${left}px; width:${width}px; z-index:1000;`,
      }, visible.map((i) => el('button', {
        type: 'button',
        role: 'menuitem',
        class: `block w-full text-left px-3 py-1.5 text-[12px] hover:bg-sand ${i.danger ? 'text-crit' : 'text-ink-700'}`,
        onClick: (ev) => { ev.stopPropagation(); close(); i.onClick && i.onClick(); },
      }, [i.label])));
      document.body.append(menu);
      // Listeners en próximo tick para no capturar este click.
      setTimeout(() => {
        document.addEventListener('click',   onOutside, true);
        document.addEventListener('keydown', onEsc,     true);
        window.addEventListener('scroll',    close,     true);
        window.addEventListener('resize',    close,     true);
      }, 0);
    },
  }, [label]);

  return btn;
}
