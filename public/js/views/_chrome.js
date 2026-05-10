// Shared shell: sidebar drawer (mobile) / sticky aside (desktop) +
// topbar with hamburger (mobile) + bottom-nav (mobile).
// Matches the CTRM mobile pattern.
import { el } from '../ui/el.js';
import { getSession, logout } from '../auth.js';
import { navigate, currentPath, setSession } from '../router.js';
import { api } from '../api.js';
import { toast } from '../ui/toast.js';
import { confirmModal } from '../ui/modal.js';

// ─── Inline SVG icons (Lucide-style strokes) ──────────────────────────
const ICONS = {
  dashboard: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
  plus:      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  external:  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-4"/><path d="M14 3h7v7"/><path d="M21 3l-9 9"/></svg>',
  book:      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v15a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2zM7 7h10M7 11h10M7 15h6"/></svg>',
  inbox:     '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
  box:       '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  menu:      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>',
  truck:     '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="6" width="13" height="11" rx="1"/><polygon points="14 9 18 9 22 13 22 17 14 17 14 9"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="18.5" r="2"/></svg>',
  close:     '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  more:      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>',
  mail:      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>',
  logout:    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  chart:     '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="20" x2="21" y2="20"/><rect x="5" y="12" width="3" height="7"/><rect x="10.5" y="7" width="3" height="12"/><rect x="16" y="14" width="3" height="5"/></svg>',
  calendar:  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/></svg>',
};

function iconEl(name) {
  const span = document.createElement('span');
  span.className = 'inline-flex items-center justify-center';
  span.innerHTML = ICONS[name] || '';
  return span;
}

// ─── Nav config ───────────────────────────────────────────────────────
const FOREST_NAV = [
  { path: '/forest/dashboard',  label: 'Tablero',      icon: 'dashboard' },
  { path: '/forest/demand',     label: 'Nuevo pedido', icon: 'plus' },
  { path: '/forest/external',   label: 'Externos',     icon: 'external' },
  { path: '/forest/references', label: 'Referencias',  icon: 'book' },
  { path: '/calendar',          label: 'Calendario',   icon: 'calendar' },
  { path: '/reports',           label: 'Reportes',     icon: 'chart' },
];

const FINCA_NAV = [
  { path: '/finca/dashboard', label: 'Tablero',           icon: 'dashboard' },
  { path: '/finca/inbox',     label: 'Pedidos entrantes', icon: 'inbox' },
  { path: '/finca/lots',      label: 'Producción',        icon: 'box' },
  { path: '/finca/despachos', label: 'Despachos',         icon: 'truck' },
  { path: '/calendar',        label: 'Calendario',        icon: 'calendar' },
  { path: '/reports',         label: 'Reportes',          icon: 'chart' },
];

function navSections(role) {
  const sections = [];
  if (role === 'forest' || role === 'admin') sections.push({ label: 'Forest', items: FOREST_NAV });
  if (role === 'finca'  || role === 'admin') sections.push({ label: 'El Vergel', items: FINCA_NAV });
  return sections;
}

function bottomNavItems(role) {
  if (role === 'finca') return [
    { path: '/finca/dashboard', label: 'Inicio',     icon: 'dashboard' },
    { path: '/finca/inbox',     label: 'Entrantes',  icon: 'inbox' },
    { path: '/finca/lots',      label: 'Producción', icon: 'box' },
    { kind: 'more',             label: 'Más',        icon: 'menu' },
  ];
  if (role === 'admin') return [
    { path: '/forest/dashboard', label: 'Forest',  icon: 'dashboard' },
    { path: '/finca/dashboard',  label: 'Finca',   icon: 'box' },
    { path: '/finca/inbox',      label: 'Entrantes', icon: 'inbox' },
    { kind: 'more',              label: 'Más',     icon: 'menu' },
  ];
  // forest (default)
  return [
    { path: '/forest/dashboard', label: 'Inicio',   icon: 'dashboard' },
    { path: '/forest/demand',    label: 'Nuevo',    icon: 'plus' },
    { path: '/forest/external',  label: 'Externos', icon: 'external' },
    { kind: 'more',              label: 'Más',      icon: 'menu' },
  ];
}

// ─── Open / close drawer ─────────────────────────────────────────────
function openSidebar()  { document.body.classList.add('sidebar-open'); }
function closeSidebar() { document.body.classList.remove('sidebar-open'); }

// ─── Public chrome wrapper ───────────────────────────────────────────
export function chrome(content) {
  const session = getSession();
  const role    = session?.role;
  const cur     = currentPath();
  const sections = navSections(role);
  const bottom   = bottomNavItems(role);

  // ── Sidebar ─────────────────────────────────────────────────────
  const sidebar = el('aside', { class: 'sidebar', id: 'app-sidebar' }, [
    el('div', { class: 'sidebar-header' }, [
      el('div', { class: 'sidebar-brand' }, [
        el('div', { class: 'ctrm-topbar-logo' }, ['F']),
        el('div', { class: 'flex flex-col min-w-0' }, [
          el('span', { class: 'sidebar-brand-title' }, ['Forest ↔ Vergel']),
          el('span', { class: 'text-[10px] font-mono text-white/40 tracking-loose' }, ['Production Bridge']),
        ]),
      ]),
      el('button', {
        class: 'sidebar-close',
        type: 'button',
        onClick: closeSidebar,
        'aria-label': 'Cerrar menú',
      }, [iconEl('close')]),
    ]),

    // Admin-only "Resumen ahora" CTA
    role === 'admin' ? el('div', { class: 'sidebar-cta-wrap' }, [
      el('button', {
        class: 'sidebar-cta',
        type: 'button',
        onClick: () => { closeSidebar(); triggerDigest(); },
      }, [iconEl('mail'), el('span', {}, ['Resumen ahora'])]),
    ]) : null,

    el('nav', { class: 'sidebar-nav' }, sections.map((sec) =>
      el('div', { class: 'sidebar-section' }, [
        el('div', { class: 'sidebar-section-label', text: sec.label }),
        ...sec.items.map((item) =>
          el('button', {
            type: 'button',
            class: `sidebar-link ${cur === item.path ? 'is-active' : ''}`,
            onClick: () => { navigate(item.path); closeSidebar(); },
          }, [iconEl(item.icon), el('span', { text: item.label })]),
        ),
      ]),
    )),

    el('div', { class: 'sidebar-footer' }, [
      el('button', {
        type: 'button',
        class: 'sidebar-footer-btn',
        onClick: async () => { closeSidebar(); await logout(); setSession(null); navigate('/login'); },
      }, [iconEl('logout'), el('span', {}, ['Salir'])]),
    ]),
  ]);

  // Backdrop (mobile only)
  const backdrop = el('div', {
    class: 'sidebar-backdrop',
    onClick: closeSidebar,
  });

  // ── Topbar (mobile-prominent: hamburger + brand + role) ─────────
  const topbar = el('header', { class: 'app-topbar' }, [
    el('button', {
      type: 'button',
      class: 'topbar-menu-btn',
      onClick: openSidebar,
      'aria-label': 'Abrir menú',
    }, [iconEl('menu')]),

    el('div', { class: 'topbar-brand' }, [
      el('div', { class: 'ctrm-topbar-logo' }, ['F']),
      el('span', { class: 'topbar-brand-title' }, ['Forest ↔ Vergel']),
    ]),

    el('div', { class: 'topbar-status' }, [
      el('span', { class: 'topbar-status-dot' }),
      el('span', { class: 'topbar-role-pill', text: role || '' }),
    ]),
  ]);

  // ── Bottom nav (mobile) ─────────────────────────────────────────
  const bottomNav = el('nav', { class: 'bottom-nav' }, bottom.map((item) => {
    if (item.kind === 'more') {
      return el('button', {
        type: 'button',
        class: 'bottom-nav-btn',
        onClick: openSidebar,
      }, [iconEl(item.icon), el('span', { text: item.label })]);
    }
    return el('button', {
      type: 'button',
      class: `bottom-nav-btn ${cur === item.path ? 'is-active' : ''}`,
      onClick: () => navigate(item.path),
    }, [iconEl(item.icon), el('span', { text: item.label })]);
  }));

  return el('div', { class: 'app-shell' }, [
    sidebar,
    backdrop,
    el('div', { class: 'app-main' }, [
      topbar,
      el('main', { class: 'app-content' }, [content]),
      bottomNav,
    ]),
  ]);
}

async function triggerDigest() {
  const ok = await confirmModal(
    'Se enviará el resumen semanal ahora a todos los destinatarios configurados (o se registrará como dry-run).',
    { title: 'Enviar resumen ahora', confirmText: 'Enviar' },
  );
  if (!ok) return;
  try {
    const r = await api.digestTrigger();
    const dr = r.dispatch?.dryRun ? ' (dry-run)' : '';
    toast(`Resumen enviado${dr}`, 'success', 4500);
  } catch (e) { toast(e.message || 'Error', 'error'); }
}

// ─── Page title (rendered inside content area) ───────────────────────
export function pageTitle(title, subtitle) {
  return el('div', { class: 'mb-5 flex flex-col gap-0.5' }, [
    el('h1', { class: 'page-h', text: title }),
    subtitle ? el('p', { class: 'page-sub', text: subtitle }) : null,
  ]);
}
