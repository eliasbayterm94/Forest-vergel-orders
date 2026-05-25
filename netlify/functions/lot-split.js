'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /lot-split  (finca, admin)
 *
 * Divide un bache en un sub-bache (hijo) que se procesa de forma
 * independiente. El padre conserva el kg restante.
 *
 * Body:
 *   production_lot_id   uuid del lote padre
 *   kg_to_split         kg a separar (de la masa principal del bache)
 *   notes?              notas opcionales
 *
 * El sub-bache hereda del padre: reference_id, process_type,
 * processing_stage, infusion, status, todas las fechas acumuladas.
 * Su bache_code se autogenera como "{padre}-P{n}".
 *
 * Kg proporcional: el ratio = kg_to_split / padre.kg_input_initial
 * (actual) y se aplica a todos los campos de masa.
 *
 * Permitido en: InFermentation, Drying, Resting, Ready.
 */
exports.handler = requireAuth(['finca', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const { production_lot_id, notes } = body || {};
  if (!production_lot_id) return badReq('production_lot_id required', 'LOT_ID_REQUIRED');
  const kgToSplit = Number(body.kg_to_split);
  if (!Number.isFinite(kgToSplit) || kgToSplit <= 0) {
    return badReq('kg_to_split must be > 0', 'INVALID_KG');
  }

  const sb = getSupabase();

  // Cargar padre
  const { data: parent, error: pErr } = await sb
    .from('production_lots').select('*').eq('id', production_lot_id).maybeSingle();
  if (pErr) return serverErr('Lookup failed', pErr.message);
  if (!parent) return notFound('Lot not found');

  const SPLITTABLE = new Set(['InFermentation', 'Drying', 'Resting', 'Ready']);
  if (!SPLITTABLE.has(parent.status)) {
    return conflict(`No se puede dividir un lote en estado ${parent.status}`, 'NOT_SPLITTABLE');
  }

  // Masa base para el ratio
  const baseKg = Number(parent.kg_input_initial || 0);
  if (baseKg <= 0) {
    return conflict('El lote padre no tiene kg_input_initial registrado', 'NO_KG');
  }
  if (kgToSplit >= baseKg) {
    return conflict('kg_to_split debe ser menor al total del padre', 'EXCEEDS_PARENT');
  }

  const ratio = kgToSplit / baseKg;
  const remainRatio = 1 - ratio;

  // Próximo número P
  const { data: existingChildren } = await sb
    .from('production_lots')
    .select('sub_bache_number')
    .eq('parent_lot_id', parent.id)
    .order('sub_bache_number', { ascending: false })
    .limit(1);
  const nextP = (existingChildren && existingChildren[0] ? existingChildren[0].sub_bache_number : 0) + 1;

  // bache_code del hijo
  const parentCode = parent.bache_code || parent.blend_code || parent.lot_code || 'LOT';
  const childBacheCode = `${parentCode}-P${nextP}`;

  // Campos proporcionales
  const scale = (val) => val != null ? Math.round(Number(val) * ratio * 100) / 100 : null;
  const scaleRemain = (val) => val != null ? Math.round(Number(val) * remainRatio * 100) / 100 : null;

  const childLot = {
    parent_lot_id: parent.id,
    sub_bache_number: nextP,
    bache_code: childBacheCode,
    reference_id: parent.reference_id,
    process_type: parent.process_type,
    processing_stage: parent.processing_stage,
    status: parent.status,
    infusion_id: parent.infusion_id,
    infusion_pct: parent.infusion_pct,
    start_date: parent.start_date,
    drying_start_date: parent.drying_start_date,
    drying_locations: parent.drying_locations,
    resting_start_date: parent.resting_start_date,
    resting_humidity: parent.resting_humidity,
    ready_date: parent.ready_date,
    fermentation_hours: parent.fermentation_hours,
    kg_input_initial: scale(parent.kg_input_initial),
    kg_cherry_input: scale(parent.kg_cherry_input),
    kg_despulpado_input: scale(parent.kg_despulpado_input),
    kg_green_expected: scale(parent.kg_green_expected),
    kg_dried_output: scale(parent.kg_dried_output),
    kg_green_actual: scale(parent.kg_green_actual),
    factor_rendimiento: parent.factor_rendimiento,
    conversion_factor: parent.conversion_factor,
    notes: notes || null,
    created_by: session.role,
  };

  // Insertar hijo
  const { data: child, error: cErr } = await sb
    .from('production_lots').insert(childLot).select().single();
  if (cErr) {
    if (/uq_production_lots_bache_code|production_lots_bache_code_key/i.test(cErr.message)) {
      return conflict(`Ya existe el código ${childBacheCode}`, 'DUPLICATE_CODE');
    }
    return serverErr('Child lot insert failed', cErr.message);
  }

  // Copiar variedades
  const { data: parentVars } = await sb
    .from('production_lot_varieties').select('variety_id')
    .eq('production_lot_id', parent.id);
  if (parentVars && parentVars.length > 0) {
    await sb.from('production_lot_varieties').insert(
      parentVars.map((v) => ({ production_lot_id: child.id, variety_id: v.variety_id })),
    );
  }

  // Copiar ciclos de reposo activos (si el padre está en Resting/tiene ciclos)
  const { data: parentCycles } = await sb
    .from('lot_resting_cycles').select('*').eq('production_lot_id', parent.id);
  if (parentCycles && parentCycles.length > 0) {
    const cycleCopies = parentCycles.map((c) => ({
      production_lot_id: child.id,
      cycle_number: c.cycle_number,
      start_date: c.start_date,
      start_humidity: c.start_humidity,
      end_date: c.end_date,
      end_humidity: c.end_humidity,
      end_reason: c.end_reason,
    }));
    await sb.from('lot_resting_cycles').insert(cycleCopies);
  }

  // Reducir padre
  const parentUpdate = {
    kg_input_initial: scaleRemain(parent.kg_input_initial),
    kg_cherry_input: scaleRemain(parent.kg_cherry_input),
    kg_despulpado_input: scaleRemain(parent.kg_despulpado_input),
    kg_green_expected: scaleRemain(parent.kg_green_expected),
    kg_dried_output: scaleRemain(parent.kg_dried_output),
    kg_green_actual: scaleRemain(parent.kg_green_actual),
  };
  const { error: upErr } = await sb
    .from('production_lots').update(parentUpdate).eq('id', parent.id);
  if (upErr) return serverErr('Parent update failed', upErr.message);

  return ok({ parent: { id: parent.id, ...parentUpdate }, child });
});
