// Shared shell: top nav + content area for authenticated views.
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

  const nav = el('nav', { class: 'flex gap-1 overflow-x-auto -mb-px' },
    items.map((it) => el('a', {
      href: `#${it.path}`,
      class: `whitespace-nowrap px-3 py-2 text-sm rounded-t-lg ${cur === it.path ? 'bg-white text-forest border border-b-white border-slate-200 font-medium' : 'text-white/80 hover:text-white'}`,
      onClick: (e) => { e.preventDefault(); navigate(it.path); },
    }, [it.label])),
  );

  const header = el('header', { class: 'bg-forest text-white' }, [
    el('div', { class: 'max-w-5xl mx-auto px-4 pt-3' }, [
      el('div', { class: 'flex items-center justify-between mb-2' }, [
        el('div', { class: 'flex items-center gap-2' }, [
          el('div', { class: 'w-8 h-8 rounded bg-white/15 flex items-center justify-center text-sm font-bold' }, ['F']),
          el('h1', { class: 'font-semibold tracking-tight' }, ['Forest ↔ El Vergel']),
        ]),
        el('div', { class: 'flex items-center gap-2 text-xs' }, [
          el('span', { class: 'px-2 py-0.5 rounded bg-white/15' }, [session?.role || '']),
          session?.role === 'admin' ? el('button', {
            class: 'px-2 py-1 rounded bg-white/15 hover:bg-white/25',
            onClick: () => triggerDigest(),
          }, ['Resumen ahora']) : null,
          el('button', {
            class: 'px-2 py-1 hover:underline',
            onClick: async () => { await logout(); setSession(null); navigate('/login'); },
          }, ['Salir']),
        ]),
      ]),
      nav,
    ]),
  ]);

  return el('div', { class: 'min-h-[100dvh]' }, [
    header,
    el('main', { class: 'max-w-5xl mx-auto px-4 py-4' }, [content]),
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
  return el('div', { class: 'mb-4' }, [
    el('h2', { class: 'text-lg font-semibold text-slate-900', text: title }),
    subtitle ? el('p', { class: 'text-sm text-slate-500', text: subtitle }) : null,
  ]);
}
