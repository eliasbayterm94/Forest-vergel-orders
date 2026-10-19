'use strict';

// Snapshot automático al cerrar en seco, anulación al deshacer, y
// reparto en las divisiones.
//
// LA PROPIEDAD MÁS IMPORTANTE QUE PROTEGEN ESTOS TESTS:
// el costeo NUNCA tumba la operación. Cerrar un bache, deshacer una
// etapa o dividir un lote tiene que funcionar aunque no haya tarifas,
// no se haya registrado el origen de la materia, o las migraciones de
// costeo no estén aplicadas.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fake-supabase');
const { loadHandler, setFake, postEvent, parseRes } = require('./helpers/fn-harness');

const LOT = 'dddddddd-0000-0000-0000-000000000001';
const PARAM = 'param-0001';

function base({ sources = [], params = [], snapshots = [], lot = {} } = {}) {
  return {
    production_lots: [{
      id: LOT, bache_code: '26-400', lot_code: 'LOT-400', status: 'Drying',
      lot_kind: 'main', is_blend: false, processing_stage: 'cereza',
      kg_input_initial: 1000, kg_cherry_input: 1000, kg_green_expected: 130.72,
      kg_dried_output: null, factor_rendimiento: null, conversion_factor: null,
      start_date: '2026-10-01', drying_start_date: '2026-10-05', ready_date: null,
      ...lot,
    }],
    lot_partials: [],
    lot_resting_cycles: [],
    lot_order_assignments: [],
    lot_input_sources: sources,
    costing_parameters: params,
    lot_cost_snapshots: snapshots,
    lot_blend_components: [],
  };
}

const PARAMS_ROW = {
  id: PARAM, effective_from: '2026-01-01',
  t1_per_kg_net: 630, t2_per_kg_own_net: 6000,
};
const ownSource = { id: 's1', production_lot_id: LOT, kg: 1000, entry_stage: 'cereza',
  cost_basis: 'own', purchase_cost_per_kg: null, drawn_at: '2026-10-01T10:00:00Z' };
const boughtSource = { id: 's2', production_lot_id: LOT, kg: 1000, entry_stage: 'cereza',
  cost_basis: 'purchase_identified', reception_id: 'r1', purchase_cost_per_kg: 3800,
  drawn_at: '2026-10-01T10:00:00Z' };

const statusH = loadHandler('production-lots-update-status', createFakeSupabase(base()));
const undoH   = loadHandler('lot-undo-stage');

const close = (extra = {}) => postEvent({
  lot_id: LOT, status: 'Ready', kg_dried_output: 200,
  factor_rendimiento: 92.1, ready_date: '2026-10-30', ...extra,
}, { role: 'finca' });

const row = (fake) => fake._db.production_lots[0];
const snaps = (fake) => fake._db.lot_cost_snapshots;

// ══════════════════════════════════════════════════════════════
// EL CAMINO NORMAL
// ══════════════════════════════════════════════════════════════

test('cerrar en seco congela el costo (lote propio → 33.150/kg)', async () => {
  const fake = createFakeSupabase(base({ sources: [ownSource], params: [PARAMS_ROW] }));
  setFake(fake);

  const r = parseRes(await statusH(close()));
  assert.equal(r.status, 200);
  assert.equal(r.body.costing.ok, true);
  assert.equal(row(fake).status, 'Ready');

  const s = snaps(fake)[0];
  assert.equal(Number(s.t2_cost_cop), 6_000_000);
  assert.equal(Number(s.t1_cost_cop),   630_000);
  assert.equal(Number(s.kg_dried_output), 200);
  assert.equal(s.source_kind, 'computed');
  assert.equal(s.costing_parameters_id, PARAM);
});

test('cerrar en seco congela el costo (lote comprado → 22.150/kg)', async () => {
  const fake = createFakeSupabase(base({ sources: [boughtSource], params: [PARAMS_ROW] }));
  setFake(fake);

  const r = parseRes(await statusH(close()));
  assert.equal(r.body.costing.ok, true);
  const s = snaps(fake)[0];
  assert.equal(Number(s.purchase_cost_cop), 3_800_000);
  assert.equal(Number(s.t1_cost_cop),         630_000);
});

test('las tarifas quedan COPIADAS en el snapshot', async () => {
  // Por eso editar la tarifa después no mueve el costo del bache.
  const fake = createFakeSupabase(base({ sources: [ownSource], params: [PARAMS_ROW] }));
  setFake(fake);
  await statusH(close());
  const s = snaps(fake)[0];
  assert.equal(Number(s.t1_per_kg_net), 630);
  assert.equal(Number(s.t2_per_kg_own_net), 6000);
});

// ══════════════════════════════════════════════════════════════
// EL COSTEO NUNCA TUMBA LA OPERACIÓN
// ══════════════════════════════════════════════════════════════

test('SIN tarifas: el bache se cierra igual y dice por qué no se costeó', async () => {
  const fake = createFakeSupabase(base({ sources: [ownSource], params: [] }));
  setFake(fake);

  const r = parseRes(await statusH(close()));
  assert.equal(r.status, 200);                      // la operación NO falla
  assert.equal(row(fake).status, 'Ready');          // el bache quedó cerrado
  assert.equal(row(fake).kg_dried_output, 200);     // con sus kg
  assert.equal(r.body.costing.ok, false);
  assert.equal(r.body.costing.skipped, 'no_tariff');
  assert.match(r.body.costing.message, /tarifas/);
  assert.equal(snaps(fake).length, 0);
});

test('SIN origen de materia: el bache se cierra igual', async () => {
  const fake = createFakeSupabase(base({ sources: [], params: [PARAMS_ROW] }));
  setFake(fake);

  const r = parseRes(await statusH(close()));
  assert.equal(r.status, 200);
  assert.equal(row(fake).status, 'Ready');
  assert.equal(r.body.costing.skipped, 'no_sources');
  assert.match(r.body.costing.message, /no se puede costear/);
});

test('con tarifa posterior al cierre: no se costea, pero se cierra', async () => {
  // Tarifa que rige desde diciembre; el bache sale en octubre.
  const fake = createFakeSupabase(base({
    sources: [ownSource],
    params: [{ ...PARAMS_ROW, effective_from: '2026-12-01' }],
  }));
  setFake(fake);

  const r = parseRes(await statusH(close()));
  assert.equal(r.status, 200);
  assert.equal(row(fake).status, 'Ready');
  assert.equal(r.body.costing.skipped, 'no_tariff');
});

// ══════════════════════════════════════════════════════════════
// REPROCESO: NO SE COBRA DOS VECES
// ══════════════════════════════════════════════════════════════

test('un bache ya costeado no se recostea al volver a Ready', async () => {
  const fake = createFakeSupabase(base({
    sources: [ownSource], params: [PARAMS_ROW],
    lot: { status: 'Drying' },
    snapshots: [{
      id: 'snap-viejo', production_lot_id: LOT, costing_parameters_id: PARAM,
      t1_per_kg_net: 630, t2_per_kg_own_net: 6000, snapshot_date: '2026-10-30',
      kg_input_net_total: 1000, kg_input_net_own: 1000, kg_input_net_purchased: 0,
      kg_dried_output: 200, purchase_cost_cop: 0, t2_cost_cop: 6000000, t1_cost_cop: 630000,
      total_cost_cop: 6630000, cost_per_kg_dried: 33150, source_kind: 'computed', voided_at: null,
    }],
  }));
  setFake(fake);

  const r = parseRes(await statusH(close()));
  assert.equal(r.status, 200);
  assert.equal(r.body.costing.skipped, 'already_costed');
  assert.equal(snaps(fake).length, 1);              // sigue habiendo uno solo
});

// ══════════════════════════════════════════════════════════════
// DESHACER EL CIERRE ANULA (NO BORRA)
// ══════════════════════════════════════════════════════════════

test('deshacer la salida en seco ANULA el snapshot, no lo borra', async () => {
  const fake = createFakeSupabase(base({
    lot: { status: 'Ready', ready_date: '2026-10-30', kg_dried_output: 200, factor_rendimiento: 92.1 },
    snapshots: [{
      id: 'snap-1', production_lot_id: LOT, costing_parameters_id: PARAM,
      t1_per_kg_net: 630, t2_per_kg_own_net: 6000, snapshot_date: '2026-10-30',
      kg_input_net_total: 1000, kg_input_net_own: 1000, kg_input_net_purchased: 0,
      kg_dried_output: 200, purchase_cost_cop: 0, t2_cost_cop: 6000000, t1_cost_cop: 630000,
      total_cost_cop: 6630000, cost_per_kg_dried: 33150, source_kind: 'computed', voided_at: null,
    }],
  }));
  setFake(fake);

  const r = parseRes(await undoH(postEvent(
    { lot_id: LOT, event_kind: 'ready-from-drying' }, { role: 'finca' })));

  assert.equal(r.status, 200);
  assert.equal(r.body.costing.ok, true);
  assert.equal(snaps(fake).length, 1);              // sigue existiendo
  assert.ok(snaps(fake)[0].voided_at);              // pero anulado
  assert.match(snaps(fake)[0].voided_reason, /deshizo/);
  assert.equal(row(fake).status, 'Drying');
});

test('deshacer sin costo previo no es un error', async () => {
  const fake = createFakeSupabase(base({
    lot: { status: 'Ready', ready_date: '2026-10-30', kg_dried_output: 200 },
  }));
  setFake(fake);

  const r = parseRes(await undoH(postEvent(
    { lot_id: LOT, event_kind: 'ready-from-drying' }, { role: 'finca' })));
  assert.equal(r.status, 200);
  assert.equal(r.body.costing.skipped, 'no_snapshot');
  assert.equal(row(fake).status, 'Drying');
});

// ══════════════════════════════════════════════════════════════
// TRAS ANULAR, SÍ SE PUEDE COSTEAR DE NUEVO
// ══════════════════════════════════════════════════════════════

test('un bache con snapshot ANULADO sí se vuelve a costear', async () => {
  const fake = createFakeSupabase(base({
    sources: [ownSource], params: [PARAMS_ROW],
    lot: { status: 'Drying' },
    snapshots: [{
      id: 'snap-anulado', production_lot_id: LOT, costing_parameters_id: PARAM,
      t1_per_kg_net: 630, t2_per_kg_own_net: 6000, snapshot_date: '2026-09-01',
      kg_input_net_total: 1000, kg_input_net_own: 1000, kg_input_net_purchased: 0,
      kg_dried_output: 180, purchase_cost_cop: 0, t2_cost_cop: 6000000, t1_cost_cop: 630000,
      total_cost_cop: 6630000, cost_per_kg_dried: 36833.33, source_kind: 'computed',
      voided_at: '2026-09-15T00:00:00Z', voided_reason: 'se deshizo',
    }],
  }));
  setFake(fake);

  const r = parseRes(await statusH(close()));
  assert.equal(r.body.costing.ok, true);
  assert.equal(snaps(fake).length, 2);
  const live = snaps(fake).filter((s) => !s.voided_at);
  assert.equal(live.length, 1);
  assert.equal(Number(live[0].kg_dried_output), 200);
});

// ══════════════════════════════════════════════════════════════
// MEZCLAS: HEREDAN SIN REAPLICAR T1
// ══════════════════════════════════════════════════════════════

test('mezcla: hereda el promedio ponderado y NO reaplica T1', async () => {
  const P1 = 'padre-1', P2 = 'padre-2', BLEND = 'mezcla-1';
  const fake = createFakeSupabase({
    production_lots: [
      { id: BLEND, bache_code: 'MZ-2026-0001', blend_code: 'MZ-2026-0001', is_blend: true,
        lot_kind: 'main', status: 'Ready', kg_dried_output: 400, ready_date: '2026-11-01',
        processing_stage: 'seco' },
      { id: P1, bache_code: '26-401', is_blend: false, lot_kind: 'main', status: 'Delivered' },
      { id: P2, bache_code: '26-402', is_blend: false, lot_kind: 'main', status: 'Delivered' },
    ],
    lot_blend_components: [
      { blend_lot_id: BLEND, source_lot_id: P1, kg_dried_used: 100 },
      { blend_lot_id: BLEND, source_lot_id: P2, kg_dried_used: 300 },
    ],
    lot_cost_snapshots: [
      { id: 'sp1', production_lot_id: P1, cost_per_kg_dried: 22150, voided_at: null,
        t1_per_kg_net: 630, t2_per_kg_own_net: 6000 },
      { id: 'sp2', production_lot_id: P2, cost_per_kg_dried: 33150, voided_at: null,
        t1_per_kg_net: 630, t2_per_kg_own_net: 6000 },
    ],
    lot_input_sources: [], costing_parameters: [PARAMS_ROW],
  });
  setFake(fake);

  const { snapshotLotAtDryExit } = require('../netlify/functions/_lib/costSnapshot');
  const supa = require('../netlify/functions/_lib/supabase');
  const r = await snapshotLotAtDryExit(supa.getSupabase(), {
    lotId: BLEND, readyDate: '2026-11-01', actor: 'qa',
  });

  assert.equal(r.ok, true);
  assert.equal(r.inherited, true);
  const s = fake._db.lot_cost_snapshots.find((x) => x.production_lot_id === BLEND);
  // (100×22.150 + 300×33.150) = 12.160.000 sobre 400 kg = 30.400
  assert.equal(Number(s.purchase_cost_cop), 12_160_000);
  assert.equal(Number(s.t1_cost_cop), 0);           // T1 NO se reaplica
  assert.equal(Number(s.t2_cost_cop), 0);
  assert.equal(s.source_kind, 'inherited_blend');
});

test('mezcla con un componente sin costear se niega a promediar a medias', async () => {
  const P1 = 'padre-x', BLEND = 'mezcla-x';
  const fake = createFakeSupabase({
    production_lots: [
      { id: BLEND, is_blend: true, lot_kind: 'main', status: 'Ready', kg_dried_output: 200 },
      { id: P1, is_blend: false, lot_kind: 'main' },
    ],
    lot_blend_components: [{ blend_lot_id: BLEND, source_lot_id: P1, kg_dried_used: 200 }],
    lot_cost_snapshots: [], lot_input_sources: [], costing_parameters: [PARAMS_ROW],
  });
  setFake(fake);

  const { snapshotLotAtDryExit } = require('../netlify/functions/_lib/costSnapshot');
  const supa = require('../netlify/functions/_lib/supabase');
  const r = await snapshotLotAtDryExit(supa.getSupabase(), { lotId: BLEND, readyDate: '2026-11-01' });

  assert.equal(r.ok, false);
  assert.equal(r.skipped, 'components_uncosted');
  assert.equal(fake._db.lot_cost_snapshots.length, 0);
});
