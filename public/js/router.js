// Hash router. Routes are functions that take a `mountNode` and an
// optional params object. Roles guard which routes are accessible.
import { mount, el } from './ui/el.js';
import { skeletonView } from './ui/skeleton.js';

const _routes = new Map();
let _mountNode = null;
let _session = null;

export function defineRoute(path, { roles, view }) {
  _routes.set(path, { roles, view });
}

export function setSession(session) { _session = session; }
export function setMount(node) { _mountNode = node; }

export function navigate(path) {
  if (location.hash !== `#${path}`) location.hash = path;
  else handleHashChange();
}

export function currentPath() {
  const h = location.hash || '#/';
  const raw = h.slice(1);
  const i = raw.indexOf('?');
  return i < 0 ? raw : raw.slice(0, i);
}

/** URLSearchParams desde la query del hash actual. */
export function currentQuery() {
  const h = location.hash || '';
  const i = h.indexOf('?');
  return i < 0 ? new URLSearchParams() : new URLSearchParams(h.slice(i + 1));
}

/**
 * Update one (or more) hash query params sin disparar navigation.
 * Usa history.replaceState para evitar que se agregue al history.
 *   updateHashQuery({ range: '24m', ref: null })   // null borra
 */
export function updateHashQuery(updates) {
  const params = currentQuery();
  for (const [k, v] of Object.entries(updates || {})) {
    if (v == null || v === '') params.delete(k);
    else params.set(k, String(v));
  }
  const path = currentPath();
  const qs = params.toString();
  const newHash = qs ? `#${path}?${qs}` : `#${path}`;
  if (location.hash === newHash) return;
  history.replaceState(null, '', newHash);
}

function notFound() {
  return el('div', { class: 'p-6 text-center' }, [
    el('h2', { class: 'text-xl font-semibold mb-2', text: 'Página no encontrada' }),
    el('button', {
      class: 'mt-4 px-4 py-2 rounded-lg bg-forest text-white',
      onClick: () => navigate(defaultRouteFor(_session?.role) || '/login'),
    }, ['Volver']),
  ]);
}

function forbidden() {
  return el('div', { class: 'p-6 text-center' }, [
    el('h2', { class: 'text-xl font-semibold mb-2', text: 'Sin permisos' }),
    el('p', { class: 'text-slate-600' }, ['Tu rol no puede ver esta vista.']),
  ]);
}

export function defaultRouteFor(role) {
  if (role === 'forest') return '/forest/dashboard';
  if (role === 'finca')  return '/finca/dashboard';
  if (role === 'admin')  return '/admin/dashboard';
  return '/login';
}

export async function handleHashChange() {
  if (!_mountNode) return;
  const path = currentPath();
  const route = _routes.get(path);
  if (!route) { mount(_mountNode, notFound()); return; }
  if (route.roles && (!_session || !route.roles.includes(_session.role))) {
    mount(_mountNode, forbidden());
    return;
  }

  // Skeleton placeholder si el view tarda mas de 150ms en resolver.
  // Las rutas rapidas no muestran flicker; las lentas tienen un
  // estado de carga visible.
  let resolved = false;
  const skeletonTimer = setTimeout(() => {
    if (resolved) return;
    try {
      // Importacion perezosa para no crear un ciclo con _chrome.
      import('./views/_chrome.js').then(({ chrome }) => {
        if (resolved) return;
        mount(_mountNode, chrome(skeletonView()));
      });
    } catch { /* ignore */ }
  }, 150);

  try {
    const node = await route.view({ session: _session });
    resolved = true;
    clearTimeout(skeletonTimer);
    if (node instanceof Node) mount(_mountNode, node);
  } catch (e) {
    resolved = true;
    clearTimeout(skeletonTimer);
    mount(_mountNode, el('div', { class: 'p-6 text-rose-700' }, [`Error: ${e.message}`]));
  }
}

export function startRouter() {
  window.addEventListener('hashchange', handleHashChange);
  if (!location.hash) location.hash = defaultRouteFor(_session?.role);
  else handleHashChange();
}
