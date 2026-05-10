// Shared shell: top nav + content area for authenticated views.
// CTRM-style: navy-dark topbar, yellow logo, uppercase tracked nav tabs.
import { el } from '../ui/el.js';
import { getSession, logout } from '../auth.js';
import { navigate, currentPath, setSession } from '../router.js';
import { api } from '../api.js';
import { toast } from '../ui/toast.js';
import { confirmModal } from '../ui/modal.js';

const FOREST_NAV = [
  { path: '/forest/dashboard', label: 'Tablero' },
  { path: '/forest/demand',    label: 'Nuevo pedido' },
  { path: '/forest/external',  label: 'Externos' },
  { path: '/forest/references',label: 'Referencias' },
];

const FINCA_NAV = [
  { path: '/finca/dashboard', label: 'Tablero' },
  { path: '/finca/inbox',     label: 'Pedidos entrantes' },
  { path: '/finca/lots',      label: 'Producción' },
];

function navFor(role) {
  if (role === 'admin') return [...FOREST_NAV, ...FINCA_NAV];
  if (role === 'forest') return FOREST_NAV;
  if (role === 'finca')  return FINCA_NAV;
  return [];
}

export function chrome(content) {
  const session = getSession();
  const items = navFor(session?.role);
  const cur = currentPath();

  const navTabs = el('nav', { class: 'flex gap-0 overflow-x-auto -mb-px scrollbar-none' },
    items.map((it) => el('a', {
      href: `#${it.path}`,
      class: `ctrm-nav-tab ${cur === it.path ? 'is-active' : ''}`,
      onClick: (e) => { e.preventDefault(); navigate(it.path); },
    }, [it.label])),
  );

  const header = el('header', { class: 'ctrm-topbar' }, [
    el('div', { class: 'max-w-6xl mx-auto px-4 sm:px-6' }, [
      el('div', { class: 'flex items-center justify-between py-3' }, [
        el('div', { class: 'flex items-center gap-3 min-w-0' }, [
          el('div', { class: 'ctrm-topbar-logo' }, ['F']),
          el('div', { class: 'flex flex-col min-w-0' }, [
            el('span', { class: 'ctrm-topbar-title truncate' }, ['Forest ↔ El Vergel']),
            el('span', { class: 'text-[10px] font-mono text-white/40 tracking-loose' }, ['Production Bridge']),
          ]),
        ]),
        el('div', { class: 'flex items-center gap-2 text-[11px]' }, [
          el('span', { class: 'px-2 py-1 rounded bg-white/10 text-white/70 font-display font-semibold uppercase tracking-eyebrow text-[10px]' }, [session?.role || '']),
          session?.role === 'admin' ? el('button', {
            class: 'px-3 py-1 rounded bg-yellow text-navy-dark hover:bg-yellow-dark font-display font-semibold uppercase tracking-eyebrow text-[10px]',
            onClick: () => triggerDigest(),
          }, ['Resumen ahora']) : null,
          el('button', {
            class: 'px-2 py-1 text-white/60 hover:text-yellow text-[11px] font-medium',
            onClick: async () => { await logout(); setSession(null); navigate('/login'); },
          }, ['Salir']),
        ]),
      ]),
      navTabs,
    ]),
  ]);

  return el('div', { class: 'min-h-[100dvh] bg-cream' }, [
    header,
    el('main', { class: 'max-w-6xl mx-auto px-4 sm:px-6 py-5 sm:py-6' }, [content]),
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

export function pageTitle(title, subtitle) {
  return el('div', { class: 'mb-5 flex flex-col gap-0.5' }, [
    el('h1', { class: 'page-h', text: title }),
    subtitle ? el('p', { class: 'page-sub', text: subtitle }) : null,
  ]);
}
