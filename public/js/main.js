import { defineRoute, setMount, setSession, startRouter, navigate, defaultRouteFor } from './router.js';
import { loadSession, getSession } from './auth.js';
import { loginView }                from './views/login.js';
import { forestDashboardView }      from './views/forest-dashboard.js';
import { forestDemandFormView }     from './views/forest-demand-form.js';
import { forestReferencesView }     from './views/forest-references.js';
import { forestExternalPosView }    from './views/forest-external-pos.js';
import { fincaPlaceholderView }     from './views/finca-placeholder.js';

const FOREST_OR_ADMIN = ['forest', 'admin'];
const FINCA_OR_ADMIN  = ['finca',  'admin'];

defineRoute('/login',              { roles: null,            view: loginView });
defineRoute('/forest/dashboard',   { roles: FOREST_OR_ADMIN, view: forestDashboardView });
defineRoute('/forest/demand',      { roles: FOREST_OR_ADMIN, view: forestDemandFormView });
defineRoute('/forest/references',  { roles: FOREST_OR_ADMIN, view: forestReferencesView });
defineRoute('/forest/external',    { roles: FOREST_OR_ADMIN, view: forestExternalPosView });

defineRoute('/finca/dashboard',    { roles: FINCA_OR_ADMIN,  view: () => fincaPlaceholderView({ title: 'Tablero finca', subtitle: 'Capacidad, cola, urgencias' }) });
defineRoute('/finca/inbox',        { roles: FINCA_OR_ADMIN,  view: () => fincaPlaceholderView({ title: 'Pedidos entrantes', subtitle: 'Aceptar / rechazar con vista de capacidad' }) });
defineRoute('/finca/lots',         { roles: FINCA_OR_ADMIN,  view: () => fincaPlaceholderView({ title: 'Producción', subtitle: 'Lotes y asignaciones' }) });

window.addEventListener('app:unauthorized', () => {
  setSession(null);
  navigate('/login');
});

bootstrap();

async function bootstrap() {
  const root = document.getElementById('app');
  setMount(root);
  try {
    const session = await loadSession();
    setSession(session);
    if (!session && location.hash !== '#/login') location.hash = '/login';
    if (session && (location.hash === '' || location.hash === '#/' || location.hash === '#/login'))
      location.hash = defaultRouteFor(session.role);
    startRouter();
  } catch (e) {
    root.innerHTML = `<div class="p-6 text-rose-700">Error de arranque: ${e.message}</div>`;
  }
}
