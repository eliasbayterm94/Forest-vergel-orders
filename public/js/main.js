import { defineRoute, setMount, setSession, startRouter, navigate, defaultRouteFor } from './router.js';
import { loadSession, getSession } from './auth.js';
import { mountShortcuts } from './ui/shortcuts.js';
import { loginView }                from './views/login.js';
import { forestDashboardView }      from './views/forest-dashboard.js';
import { forestDemandFormView }     from './views/forest-demand-form.js';
import { forestDemandBulkFormView } from './views/forest-demand-bulk-form.js';
import { forestReferencesView }     from './views/forest-references.js';
import { forestExternalPosView }    from './views/forest-external-pos.js';
import { reportsView }              from './views/reports.js';
import { fincaDashboardView }       from './views/finca-dashboard.js';
import { fincaInboxView }           from './views/finca-inbox.js';
import { fincaLotsView }            from './views/finca-lots.js';
import { fincaLotsBulkFormView }    from './views/finca-lots-bulk-form.js';
import { fincaBacheDetailView }     from './views/finca-bache-detail.js';
import { fincaPuntoFinalView }      from './views/finca-punto-final.js';
import { fincaDespachosView }       from './views/finca-despachos.js';
import { fincaMonitoreoView }       from './views/finca-monitoreo.js';
import { fincaColaView }            from './views/finca-cola.js';
import { adminDashboardView }       from './views/admin-dashboard.js';
import { adminConfigView }          from './views/admin-config.js';

const FOREST_OR_ADMIN = ['forest', 'admin'];
const FINCA_OR_ADMIN  = ['finca',  'admin'];

defineRoute('/login',              { roles: null,            view: loginView });
defineRoute('/forest/dashboard',   { roles: FOREST_OR_ADMIN, view: forestDashboardView });
defineRoute('/forest/demand',      { roles: FOREST_OR_ADMIN, view: forestDemandFormView });
defineRoute('/forest/demand-bulk', { roles: FOREST_OR_ADMIN, view: forestDemandBulkFormView });
defineRoute('/forest/references',  { roles: FOREST_OR_ADMIN, view: forestReferencesView });
defineRoute('/forest/external',    { roles: FOREST_OR_ADMIN, view: forestExternalPosView });
defineRoute('/reports',            { roles: ['forest', 'finca', 'admin'], view: reportsView });

defineRoute('/finca/dashboard',    { roles: FINCA_OR_ADMIN,  view: fincaDashboardView });
defineRoute('/finca/inbox',        { roles: FINCA_OR_ADMIN,  view: fincaInboxView });
defineRoute('/finca/cola',         { roles: FINCA_OR_ADMIN,  view: fincaColaView });
defineRoute('/finca/lots',         { roles: FINCA_OR_ADMIN,  view: fincaLotsView });
defineRoute('/finca/lots-bulk',    { roles: FINCA_OR_ADMIN,  view: fincaLotsBulkFormView });
defineRoute('/finca/bache',        { roles: FINCA_OR_ADMIN,  view: fincaBacheDetailView });
defineRoute('/finca/punto-final',  { roles: FINCA_OR_ADMIN,  view: fincaPuntoFinalView });
defineRoute('/finca/despachos',    { roles: FINCA_OR_ADMIN,  view: fincaDespachosView });
defineRoute('/finca/monitoreo',    { roles: FINCA_OR_ADMIN,  view: fincaMonitoreoView });
defineRoute('/admin/dashboard',    { roles: ['admin'],       view: adminDashboardView });
defineRoute('/admin/config',       { roles: ['admin'],       view: adminConfigView });

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
    mountShortcuts(getSession);
    startRouter();
  } catch (e) {
    root.innerHTML = `<div class="p-6 text-rose-700">Error de arranque: ${e.message}</div>`;
  }
}
