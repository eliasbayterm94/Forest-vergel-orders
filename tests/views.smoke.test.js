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
  '/api/lot-costs-report': { lots: [
    { snapshot_id: 'c1', lot_id: 'l1', code: '26-300', process_type: 'Lavado', entry_stage: 'cereza',
      lot_kind: 'main', origin: 'comprado', source_kind: 'computed', snapshot_date: '2026-10-19',
      kg_input_net_total: 1000, kg_dried_output: 200, real_factor: 0.2, factor_rendimiento: 92.1,
      purchase_cost_cop: 3800000, t2_cost_cop: 0, t1_cost_cop: 630000,
      total_cost_cop: 4430000, cost_per_kg_dried: 22150, voided_at: null },
    { snapshot_id: 'c2', lot_id: 'l2', code: '26-301', process_type: 'Natural', entry_stage: 'cereza',
      lot_kind: 'main', origin: 'propio', source_kind: 'computed', snapshot_date: '2026-10-18',
      kg_input_net_total: 1000, kg_dried_output: 200, real_factor: 0.2, factor_rendimiento: null,
      purchase_cost_cop: 0, t2_cost_cop: 6000000, t1_cost_cop: 630000,
      total_cost_cop: 6630000, cost_per_kg_dried: 33150, voided_at: null },
  ], table_missing: false },
  '/api/monthly-closures-list': { closures: [
    { id: 'mc1', year: 2026, month: 9, absorbed_t1_cop: 500000, absorbed_t2_cop: 1000000,
      absorbed_total_cop: 1500000, actual_mandate_cop: 2000000, mandate_difference_cop: 500000,
      byproduct_revenue_cop: 100000, snapshot_count: 4, kg_net_processed: 3000, kg_dried_produced: 600 },
  ], ytd: { months: 1, absorbed_total_cop: 1500000, actual_mandate_cop: 2000000,
    mandate_difference_cop: 500000, difference_pct_of_mandate: 0.25,
    byproduct_revenue_cop: 100000, kg_net_processed: 3000, kg_dried_produced: 600 },
    table_missing: false },
  '/api/monthly-closure-compute': { year: 2026, month: 10, table_missing: false,
    computed: { snapshot_count: 2, absorbed_t1_cop: 1260000, absorbed_t2_cop: 6000000,
      absorbed_total_cop: 7260000, purchase_cost_cop: 3800000, total_lot_cost_cop: 11060000,
      kg_net_processed: 2000, kg_net_own: 1000, kg_net_purchased: 1000, kg_dried_produced: 400,
      inherited_blend_count: 1, real_factor: 0.2, avg_cost_per_kg_dried: 27650 },
    existing: null, snapshots: [] },
  '/api/suppliers-list': { suppliers: [
    { id: 's1', name: 'El Vergel', kind: 'own', region: null, active: true,
      floater_franchise_pct: null },
    // Con franquicia: la recepcion debe sugerir descuento = flotes - 5%.
    { id: 's2', name: 'Manzanares', kind: 'third_party', region: 'Caldas', active: true,
      floater_franchise_pct: 0.05 },
    // Inactivo y sin la columna de la 0054, como vuelve si falta migrar.
    { id: 's3', name: 'Viejo', kind: 'third_party', region: null, active: false },
  ] },
  '/api/cost-pools-list': { pools: [
    { pool_key: 'regional', kg_on_hand: 920, cop_on_hand: 2850000, avg_cost_per_kg: 3097.83,
      total_received_kg: 1000, total_drawn_kg: 80, is_short: false, went_negative: false },
    { pool_key: 'vacio', kg_on_hand: 0, cop_on_hand: 0, avg_cost_per_kg: 3000,
      total_received_kg: 500, total_drawn_kg: 500, is_short: true, went_negative: true },
  ] },
  '/api/cherry-receptions-list': { receptions: [
    { id: 'r1', reception_code: 'REC-2026-0001', received_date: '2026-10-19', entry_stage: 'cereza',
      kg_gross: 1000, price_per_kg: 3000, discount_pct: 0.05, amount_paid_cop: 2850000,
      pool_key: 'regional', kg_net: 920, byproducts: [{ id: 'b1', kg: 80, measurement: 'estimated' }],
      byproduct_summary: { kg_gross: 1000, kg_byproduct: 80, kg_net: 920, byproduct_pct: 0.08,
        discount_pct: 0.05, shortfall_pct: 0.03, has_estimates: true } },
    { id: 'r2', reception_code: 'REC-2026-0002', received_date: '2026-10-18', entry_stage: 'cereza',
      kg_gross: 2000, price_per_kg: null, discount_pct: 0, amount_paid_cop: null,
      pool_key: null, kg_net: 2000, byproducts: [], byproduct_summary: null },
  ] },
  '/api/costing-parameters-list': { costing_parameters: [
    { id: 'p1', effective_from: '2026-01-01', t1_per_kg_net: 630, t2_per_kg_own_net: 6000,
      annual_mandate_cop: 140000000, annual_agricultural_cop: 60000000,
      budget_kg_net: 1000000, budget_kg_own_net: 10000, notes: null },
  ], in_force: { id: 'p1', effective_from: '2026-01-01', t1_per_kg_net: 630, t2_per_kg_own_net: 6000 },
    today: '2026-10-19', table_missing: false },
  // Una fila con last_login_at y otra sin él: ejercita ambas ramas del
  // subtítulo en la sección de usuarios de /admin/config.
  '/api/users-list': { table_missing: false, users: [
    { id: 'u1', username: 'elias', full_name: 'Elias Bayter', role: 'admin',
      active: true,  last_login_at: '2026-09-20T14:05:00Z', created_at: '2026-09-01T00:00:00Z' },
    { id: 'u2', username: 'juan',  full_name: null,          role: 'finca',
      active: false, last_login_at: null,                   created_at: '2026-09-02T00:00:00Z' },
  ] },
  '/api/weekly-plan-get':            { plan_row: null,
    snapshot: { fermentation_used_kg: 0, mecanico_used_kg: 0, patios_natural_used_kg: 0, patios_hl_used_kg: 0 },
    capacity: { fermentation_kg: 25000, mecanico_kg: 5000, patios_natural_kg: 20000, patios_hl_kg: 40000 },
    queue_summary: { orders_count: 0, total_remaining_kg: 0 },
    queue_orders: [] },
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
  { file: 'forest-demand-bulk-form.js', fn: 'forestDemandBulkFormView', session: SESSIONS.forest },
  { file: 'forest-costeo.js',      fn: 'forestCosteoView',     session: SESSIONS.forest },
  { file: 'forest-historial.js',   fn: 'forestHistorialView',  session: SESSIONS.forest },
  { file: 'forest-references.js',  fn: 'forestReferencesView', session: SESSIONS.forest },
  { file: 'forest-external-pos.js',fn: 'forestExternalPosView',session: SESSIONS.forest },
  { file: 'reports.js',            fn: 'reportsView',          session: SESSIONS.admin },
  { file: 'finca-dashboard.js',    fn: 'fincaDashboardView',   session: SESSIONS.finca },
  { file: 'finca-inbox.js',        fn: 'fincaInboxView',       session: SESSIONS.finca },
  { file: 'finca-lots.js',         fn: 'fincaLotsView',        session: SESSIONS.finca },
  { file: 'finca-lots-bulk-form.js', fn: 'fincaLotsBulkFormView', session: SESSIONS.finca },
  { file: 'finca-punto-final.js',  fn: 'fincaPuntoFinalView',  session: SESSIONS.finca },
  { file: 'finca-recepciones.js',  fn: 'fincaRecepcionesView', session: SESSIONS.finca },
  { file: 'finca-despachos.js',    fn: 'fincaDespachosView',   session: SESSIONS.finca },
  { file: 'finca-monitoreo.js',    fn: 'fincaMonitoreoView',   session: SESSIONS.finca },
  { file: 'finca-cola.js',         fn: 'fincaColaView',        session: SESSIONS.finca },
  { file: 'finca-planeacion.js',   fn: 'fincaPlaneacionView',  session: SESSIONS.finca },
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

// ── Contenido, no solo "no explotó" ────────────────────────────────
// El smoke de arriba solo verifica que la vista devuelva un nodo. Estas
// dos revisan que lo nuevo se pinte de verdad.

test('admin-config · la sección de proveedores pinta la franquicia', async () => {
  const mod = await import(viewUrl('admin-config.js'));
  const node = await mod.adminConfigView({ session: SESSIONS.admin });
  const text = node.textContent || '';
  assert.match(text, /Proveedores/);
  assert.match(text, /Franq/, 'debe mostrarse la columna de franquicia');
  // El tipo se muestra como etiqueta, no editable: cambiarlo
  // reescribiría el costeo de todas sus recepciones pasadas.
  assert.match(text, /Tercero/);

  // Los nombres viven en el value de un input, no en el textContent.
  const vals = [...node.querySelectorAll('input')].map((i) => i.value);
  assert.ok(vals.includes('Manzanares'), 'el proveedor debe aparecer editable');
  assert.ok(vals.includes('Caldas'), 'la región debe aparecer editable');

  // 0.05 se guarda como fracción pero se edita como 5 (porcentaje):
  // nadie negocia en fracciones, y 0.05 donde iba 5 es un error de 100x.
  assert.ok(vals.includes('5'), `la franquicia debe editarse como 5, no 0.05 — vi: ${vals.join(',')}`);
});

test('finca-recepciones · pinta la cadena de pesaje y el selector kg/%', async () => {
  const mod = await import(viewUrl('finca-recepciones.js'));
  const node = await mod.fincaRecepcionesView({ session: SESSIONS.finca });
  const text = node.textContent || '';
  for (const label of ['kg bruto (balanza)', 'No. lonas', 'kg por lona', 'kg neto de café']) {
    assert.ok(text.includes(label), `falta el campo "${label}"`);
  }
  assert.match(text, /Calidad de la entrega/, 'falta el bloque de calidad');

  // La tara arranca en el estándar de 0.35.
  const vals = [...node.querySelectorAll('input')].map((i) => i.value);
  assert.ok(vals.includes('0.35'), `la tara debe venir en 0.35 — vi: ${vals.join(',')}`);

  // Los flotes se pueden digitar en kg o en %.
  const units = [...node.querySelectorAll('select')]
    .flatMap((sel) => [...sel.querySelectorAll('option')].map((o) => o.value));
  assert.ok(units.includes('pct'), 'falta la opción de digitar flotes en %');

  // Y cada recepción registrada ofrece abrir el borrador de correo.
  assert.match(text, /Correo/, 'falta el botón de borrador de correo');
});
