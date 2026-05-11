// Tab bar visual estilo "panel-merged": el tab activo comparte fondo
// con el contenedor del contenido. Sticky vertical mientras se scrollea
// el contenido; scroll horizontal con gradientes laterales que indican
// cuando hay tabs ocultos, y auto-scroll al tab activo.

import { el } from './el.js';

export function createTabBar({ tabs = [], activeKey = null, onChange = () => {} }) {
  let active = activeKey || (tabs[0] && tabs[0].key);

  const buttons = [];
  const bar = el('div', { class: 'tabbar', role: 'tablist' });
  const scroll = el('div', {
    class: 'tabbar-scroll',
    'data-overflow-left':  'false',
    'data-overflow-right': 'false',
  }, [bar]);
  const wrap = el('div', { class: 'tabbar-wrap' }, [scroll]);
  const panel = el('div', { class: 'tabbar-panel', role: 'tabpanel' });

  function refreshOverflow() {
    const max = bar.scrollWidth - bar.clientWidth;
    const x = bar.scrollLeft;
    scroll.setAttribute('data-overflow-left',  x > 1 ? 'true' : 'false');
    scroll.setAttribute('data-overflow-right', x < max - 1 ? 'true' : 'false');
  }
  bar.addEventListener('scroll', refreshOverflow, { passive: true });
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(refreshOverflow).observe(bar);
  }

  function scrollActiveIntoView() {
    const btn = buttons.find((b) => b.classList.contains('is-active'));
    if (!btn) return;
    const left = btn.offsetLeft;
    const right = left + btn.offsetWidth;
    const viewL = bar.scrollLeft;
    const viewR = viewL + bar.clientWidth;
    if (left < viewL + 24) bar.scrollLeft = Math.max(0, left - 24);
    else if (right > viewR - 24) bar.scrollLeft = right - bar.clientWidth + 24;
  }

  function renderTabs() {
    bar.innerHTML = '';
    buttons.length = 0;
    for (const t of tabs) {
      const btn = el('button', {
        type: 'button',
        role: 'tab',
        class: `tabbar-tab ${active === t.key ? 'is-active' : ''}`,
        'aria-selected': active === t.key ? 'true' : 'false',
        onClick: () => {
          if (active === t.key) return;
          active = t.key;
          renderTabs();
          requestAnimationFrame(scrollActiveIntoView);
          onChange(active);
        },
      }, [
        el('span', { text: t.label }),
        (t.count != null && t.count > 0)
          ? el('span', { class: 'tabbar-count', text: String(t.count) })
          : null,
      ]);
      buttons.push(btn);
      bar.append(btn);
    }
    // Defer overflow + scroll-into-view until after layout
    requestAnimationFrame(() => { refreshOverflow(); scrollActiveIntoView(); });
  }
  renderTabs();

  return {
    el: wrap,
    panel,
    setContent(node) {
      panel.innerHTML = '';
      if (node) panel.append(node);
    },
    setActive(key) {
      if (active === key) return;
      active = key;
      renderTabs();
    },
    getActive() { return active; },
  };
}
