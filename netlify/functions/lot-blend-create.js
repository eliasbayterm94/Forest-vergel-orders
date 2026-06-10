'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /lot-blend-create  (finca, admin)
 *
 * Crea una mezcla a partir de uno o más baches padres en status
 * Ready. La mezcla es un nuevo production_lot con is_blend=true y
 * blend_code MZ-YYYY-NNNN (autogenerado).
 *
 * Body:
 *   components: [{ source_lot_id, kg_dried_used }]   // 2+ items
 *   notes?:     string
 *
 * Reglas:
 *   · Mínimo 2 componentes.
 *   · Cada padre debe estar en status Ready y tener kg_dried disponible
 *     suficiente para cubrir kg_dried_used.
 *   · Natural solo con Natural. Honey/Lavado entre sí (H+H, H+L, L+L).
 *   · Variedades del blend = unión de variedades de los padres.
 *   · process_type del blend = el de los padres si es uniforme. Para
 *     mezclas Honey+Lavado se etiqueta como 'Honey' (el operador puede
 *     editarlo después).
 */
exports.handler = requireAuth(['finca', 'admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const components = Array.isArray(body.components) ? body.components : [];
  if (components.length < 2) {
    return badReq('Una mezcla requiere al menos 2 componentes', 'TOO_FEW_COMPONENTS');
  }

  // Normalizar y validar componentes
  for (const c of components) {
    if (!c.source_lot_id) return badReq('source_lot_id requerido', 'MISSING_LOT_ID');
    const kg = Number(c.kg_dried_used);
    if (!Number.isFinite(kg) || kg <= 0) {
      return badReq('kg_dried_used debe ser > 0', 'INVALID_KG');
    }
    c.kg_dried_used = kg;
  }

  const sb = getSupabase();

  // Cargar baches padres
  const parentIds = components.map((c) => c.source_lot_id);
  const { data: parents, error: pErr } = await sb
    .from('production_lots')
    .select('id, bache_code, blend_code, lot_code, status, process_type, kg_dried_output')
    .in('id', parentIds);
  if (pErr) return serverErr('Lookup failed', pErr.message);
  if (!parents || parents.length !== parentIds.length) {
    return notFound('Algún bache no existe');
  }

  // Validar status Ready
  for (const p of parents) {
    if (p.status !== 'Ready') {
      return conflict(`Bache ${p.bache_code || p.blend_code || p.id} no está Ready (estado: ${p.status})`, 'NOT_READY');
    }
  }

  // Validar reglas de proceso
  const processes = [...new Set(parents.map((p) => p.process_type))];
  const hasNatural = processes.includes('Natural');
  const hasHorL    = processes.includes('Honey') || processes.includes('Lavado');
  if (hasNatural && hasHorL) {
    return conflict('Natural no se puede mezclar con Honey/Lavado', 'PROCESS_INCOMPATIBLE');
  }
  if (hasNatural && processes.length > 1) {
    return conflict('Natural solo se mezcla con Natural', 'PROCESS_INCOMPATIBLE');
  }

  // Validar disponibilidad: kg_dried_available = kg_dried_output
  //   − Σ kg_dried_used previo en mezclas − Σ kg en partials despachados.
  const { data: prevBlendUse } = await sb
    .from('lot_blend_components')
    .select('source_lot_id, kg_dried_used')
    .in('source_lot_id', parentIds);
  const usedByBlend = new Map();
  for (const r of prevBlendUse || []) {
    usedByBlend.set(r.source_lot_id, (usedByBlend.get(r.source_lot_id) || 0) + Number(r.kg_dried_used || 0));
  }
  // Kg seco ya despachado por shipment_lots (whole-lot por kg o
  // por partial). Antes este bloque consultaba lot_partials.shipment_id
  // que no existe como columna — ahora vamos por shipment_lots.
  const { data: shipLinks } = await sb
    .from('shipment_lots')
    .select('production_lot_id, kg_dried_shipped, lot_partials(kg_dried)')
    .in('production_lot_id', parentIds);
  const usedByPartials = new Map();
  for (const r of shipLinks || []) {
    let kgUsed = 0;
    if (r.kg_dried_shipped != null) kgUsed = Number(r.kg_dried_shipped);
    else if (r.lot_partials && r.lot_partials.kg_dried != null) kgUsed = Number(r.lot_partials.kg_dried);
    if (kgUsed > 0) {
      usedByPartials.set(r.production_lot_id, (usedByPartials.get(r.production_lot_id) || 0) + kgUsed);
    }
  }

  const requestedByLot = new Map();
  for (const c of components) {
    requestedByLot.set(c.source_lot_id, (requestedByLot.get(c.source_lot_id) || 0) + c.kg_dried_used);
  }
  for (const p of parents) {
    const available = Number(p.kg_dried_output || 0)
                      - (usedByBlend.get(p.id) || 0)
                      - (usedByPartials.get(p.id) || 0);
    const requested = requestedByLot.get(p.id) || 0;
    if (requested > available + 0.01) {
      return conflict(
        `Bache ${p.bache_code || p.blend_code || p.lot_code}: solicitado ${requested} kg seco, disponible ${Math.round(available * 100) / 100} kg`,
        'INSUFFICIENT_KG');
    }
  }

  // Calcular agregados
  const kgDriedTotal = components.reduce((s, c) => s + c.kg_dried_used, 0);
  const blendProcess = hasNatural ? 'Natural' : 'Honey'; // H+L queda como Honey

  // Variedades unión
  const { data: parentVars } = await sb
    .from('production_lot_varieties')
    .select('production_lot_id, variety_id')
    .in('production_lot_id', parentIds);
  const blendVarIds = [...new Set((parentVars || []).map((r) => r.variety_id))];

  // ── Insertar el blend lot ─────────────────────────────────────
  // Referencia: usamos la del primer padre (el operador puede editar).
  const firstParent = parents[0];
  const { data: firstParentFull } = await sb
    .from('production_lots')
    .select('reference_id, processing_stage, start_date')
    .eq('id', firstParent.id).maybeSingle();

  const insert = {
    is_blend: true,
    status: 'Ready',
    process_type: blendProcess,
    processing_stage: 'seco',
    kg_input_initial: kgDriedTotal,
    kg_dried_output: kgDriedTotal,
    kg_green_expected: kgDriedTotal / (blendProcess === 'Natural' ? 3.4 : 1.5),
    start_date: (firstParentFull && firstParentFull.start_date) || new Date().toISOString().slice(0, 10),
    ready_date: new Date().toISOString().slice(0, 10),
    reference_id: firstParentFull && firstParentFull.reference_id,
    notes: body.notes || null,
  };
  const { data: blendLot, error: insErr } = await sb
    .from('production_lots').insert(insert).select().single();
  if (insErr) return serverErr('Blend create failed', insErr.message);

  // Componentes
  const compRows = components.map((c) => ({
    blend_lot_id: blendLot.id,
    source_lot_id: c.source_lot_id,
    kg_dried_used: c.kg_dried_used,
  }));
  const { error: compErr } = await sb.from('lot_blend_components').insert(compRows);
  if (compErr) {
    // rollback manual del blend lot
    await sb.from('production_lots').delete().eq('id', blendLot.id);
    return serverErr('Components insert failed', compErr.message);
  }

  // Variedades del blend
  if (blendVarIds.length > 0) {
    const varRows = blendVarIds.map((variety_id) => ({
      production_lot_id: blendLot.id, variety_id,
    }));
    await sb.from('production_lot_varieties').insert(varRows);
  }

  return ok({ blend: blendLot, components: compRows });
});
