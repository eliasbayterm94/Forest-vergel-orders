// Smoke tests para cada view. Verifica que la funcion exportada se
// puede ejecutar sin throw, devuelve un Node, y todas las llamadas
// HTTP responden con shapes vacios pero validos.
//
// Cada vez que un view explota en runtime (acceso a undefined,
// llamada a una propiedad inexistente, render con datos vacios) este
// test lo atrapa antes del deploy. NO valida correctitud de la UI;
// solo "no truena con datos vacios".

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const path = require('path');
const { pathToFileURL } = require('url');

// ── DOM globals ────────────────────────────────────────────────────
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>',
  { url: 'http://localhost/', pretendToBeVisual: true });

globalThis.window               = dom.window;
globalThis.document             = dom.window.document;
globalThis.HashChangeEvent      = dom.window.HashChangeEvent;
globalThis.Node                 = dom.window.Node;
globalThis.Element              = dom.window.Element;
globalThis.URLSearchParams      = dom.window.URLSearchParams;
globalThis.URL                  = dom.window.URL;
globalThis.Blob                 = dom.window.Blob;
globalThis.HTMLElement          = dom.window.HTMLElement;
globalThis.location             = dom.window.location;
globalThis.localStorage         = dom.window.localStorage;
globalThis.sessionStorage       = dom.window.sessionStorage;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

// ── Canned fetch ───────────────────────────────────────────────────
// Cada endpoint devuelve un shape minimo valido. Si un view necesita
// algo distinto, lo detectamos cuando truene y agregamos el caso aqui.
const CANNED = {
  '/api/orders-list':                { orders: [], today: '2026-05-09' },
  '/api/demand-orders-list':         { orders: [], today: '2026-05-09' },
  '/api/production-lots-list':       { lots: [] },
  '/api/shipments-list':             { shipments: [] },
  '/api/coffee-references-list':     { references: [] },
  '/api/coffee-varieties-list':      { varieties: [] },
  '/api/process-lead-times-list':    { process_lead_times: [
    { process_type: 'Natural', drying_days: 12, dried_to_green_divisor: 3.40 },
    { process_type: 'Honey',   drying_days: 8,  dried_to_green_divisor: 1.50 },
    { process_type: 'Lavado',  drying_days: 8,  dried_to_green_divisor: 1.34 },
  ]},
  '/api/external-pos-list':          { externals: [] },
  '/api/audit-log-list':             { events: [] },
  '/api/capacity-calculate':         { orders: [], aggregate: {}, weekly_load: [] },
  '/api/search':                     { q: '', orders: [], lots: [], shipments: [] },
  '/api/badges':                     { pending_orders: 0, urgent_orders: 0, ready_lots_unshipped: 0 },
  '/api/email-log-list':             { emails: [] },
  '/api/production-config-get':      { config: { weekly_cherry_capacity_kg: 60000 } },
};

function pathOf(url) {
  try { return new URL(url, 'http://localhost').pathname; }
  catch { return url; }
}

globalThis.fetch = async (url) => {
  const p = pathOf(url);
  const body = CANNED[p] != null ? CANNED[p] : (
    // fallback genérico: la mayoría de los endpoints list devuelven {}
    { ok: true }
  );
  return {
    ok: true, status: 200, statusText: 'OK',
    headers: { get: (k) => k.toLowerCase() === 'content-type' ? 'application/json' : null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
};

// ── Resolve view module URL ────────────────────────────────────────
const VIEWS_DIR = path.resolve(__dirname, '..', 'public', 'js', 'views');
function viewUrl(file) {
  return pathToFileURL(path.join(VIEWS_DIR, file)).href;
}

// ── Sessions per role ──────────────────────────────────────────────
const SESSIONS = {
  forest: { role: 'forest' },
  finca:  { role: 'finca' },
  admin:  { role: 'admin' },
};

const VIEW_CASES = [
  { file: 'login.js',              fn: 'loginView',            session: null },
  { file: 'forest-dashboard.js',   fn: 'forestDashboardView',  session: SESSIONS.forest },
  { file: 'forest-demand-form.js', fn: 'forestDemandFormView', session: SESSIONS.forest },
  { file: 'forest-references.js',  fn: 'forestReferencesView', session: SESSIONS.forest },
  { file: 'forest-external-pos.js',fn: 'forestExternalPosView',session: SESSIONS.forest },
  { file: 'reports.js',            fn: 'reportsView',          session: SESSIONS.admin },
  { file: 'calendar.js',           fn: 'calendarView',         session: SESSIONS.finca },
  { file: 'finca-dashboard.js',    fn: 'fincaDashboardView',   session: SESSIONS.finca },
  { file: 'finca-inbox.js',        fn: 'fincaInboxView',       session: SESSIONS.finca },
  { file: 'finca-lots.js',         fn: 'fincaLotsView',        session: SESSIONS.finca },
  { file: 'finca-despachos.js',    fn: 'fincaDespachosView',   session: SESSIONS.finca },
  { file: 'finca-monitoreo.js',    fn: 'fincaMonitoreoView',   session: SESSIONS.finca },
  { file: 'finca-cola.js',         fn: 'fincaColaView',        session: SESSIONS.finca },
  { file: 'admin-dashboard.js',    fn: 'adminDashboardView',   session: SESSIONS.admin },
  { file: 'admin-config.js',       fn: 'adminConfigView',      session: SESSIONS.admin },
];

for (const { file, fn, session } of VIEW_CASES) {
  test(`view smoke · ${file}`, async () => {
    const mod = await import(viewUrl(file));
    assert.equal(typeof mod[fn], 'function', `${fn} should be exported as a function`);
    const node = await mod[fn]({ session });
    assert.ok(node instanceof dom.window.Node, `${fn} should return a DOM Node`);
  });
}
