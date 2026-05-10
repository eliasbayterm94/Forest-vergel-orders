// Hash router. Routes are functions that take a `mountNode` and an
// optional params object. Roles guard which routes are accessible.
import { mount, el } from './ui/el.js';

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
  return h.slice(1);
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
  // call view; it must return a Node (or set its own content async)
  try {
    const node = await route.view({ session: _session });
    if (node instanceof Node) mount(_mountNode, node);
  } catch (e) {
    mount(_mountNode, el('div', { class: 'p-6 text-rose-700' }, [`Error: ${e.message}`]));
  }
}

export function startRouter() {
  window.addEventListener('hashchange', handleHashChange);
  if (!location.hash) location.hash = defaultRouteFor(_session?.role);
  else handleHashChange();
}
