// Tab bar visual estilo "panel-merged": el tab activo comparte fondo
// con el contenedor del contenido. Reemplaza los chip-button selectors
// donde haya secciones de navegacion dentro de una vista (forest
// dashboard, etc).
//
// API:
//   const tabs = createTabBar({
//     tabs: [
//       { key: 'a', label: 'Tab A', count?: 3 },
//       { key: 'b', label: 'Tab B' },
//     ],
//     activeKey: 'a',
//     onChange: (key) => {},
//   });
//   container.append(tabs.el, tabs.panel);

import { el } from './el.js';

export function createTabBar({ tabs = [], activeKey = null, onChange = () => {} }) {
  let active = activeKey || (tabs[0] && tabs[0].key);

  const buttons = [];
  const bar = el('div', { class: 'tabbar', role: 'tablist' });
  const panel = el('div', { class: 'tabbar-panel', role: 'tabpanel' });

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
  }
  renderTabs();

  return {
    el: bar,
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
