'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { inputToGreen, INPUT_STAGE_DIVISORS } = require('./_lib/processYields');
const { PROCESS_TYPES } = require('./_lib/schema');
const { created, badReq, conflict, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

const MAX_LOTS_PER_BATCH = 50;

/**
 * POST /production-lots-create-bulk  (finca, admin)
 * Body: { lots: [...] }
 *
 * Cada elemento de `lots` tiene el shape del endpoint single
 * (production-lots-create) excepto initial_assignments — los lotes
 * creados en bulk arrancan sin asignaciones; el operario las agrega
 * desde la vista de producción.
 *
 * Validación por fila: si cualquiera falla, no se crea ninguno.
 * Atomicidad: INSERT array de lotes + INSERT array de variedades.
 * Si la segunda inserción falla, se borran los lotes recién creados.
 */
exports.handler = requireAuth(['finca', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const lots = Array.isArray(body.lots) ? body.lots : null;
  if (!lots || lots.length === 0) return badReq('lots array required', 'NO_LOTS');
  if (lots.length > MAX_LOTS_PER_BATCH) {
    return badReq(`max ${MAX_LOTS_PER_BATCH} lots per batch`, 'TOO_MANY');
  }

  // ── Validar cada fila ──
  const rowErrors = [];
  const cleaned = [];
  const bacheCodesSeen = new Set();
  lots.forEach((o, idx) => {
    const errs = [];
    const bache_code = (o.bache_code == null ? '' : String(o.bache_code)).trim();
    const reference_id = o.reference_id;
    const process_type = o.process_type;
    const processing_stage = o.processing_stage;
    const kg_input_amount = Number(o.kg_input_amount);
    const start_date = o.start_date;
    const fermentation_hours = o.fermentation_hours == null ? null : Number(o.fermentation_hours);
    const variety_ids = Array.isArray(o.variety_ids) ? o.variety_ids : [];
    const notes = o.notes == null ? null : String(o.notes);
    let infusion_id = o.infusion_id || null;
    let infusion_pct = o.infusion_pct == null ? null : Number(o.infusion_pct);

    if (!bache_code) errs.push('bache_code required');
    else if (bache_code.length > 60) errs.push('bache_code too long (max 60)');
    else {
      const lower = bache_code.toLowerCase();
      if (bacheCodesSeen.has(lower)) errs.push(`bache_code duplicado en el batch: "${bache_code}"`);
      else bacheCodesSeen.add(lower);
    }
    if (!PROCESS_TYPES.includes(process_type)) errs.push('process_type invalid');
    if (!processing_stage || !INPUT_STAGE_DIVISORS[processing_stage]) {
      errs.push('processing_stage must be cereza, despulpado, or seco');
    }
    if (!Number.isFinite(kg_input_amount) || kg_input_amount <= 0) {
      errs.push('kg_input_amount must be > 0');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date || '')) errs.push('start_date must be YYYY-MM-DD');
    if (fermentation_hours != null && (!Number.isFinite(fermentation_hours) || fermentation_hours < 0))
      errs.push('fermentation_hours must be >= 0');
    if (variety_ids.length === 0) errs.push('al menos una variedad es requerida');
    if (infusion_id || infusion_pct != null) {
      if (!infusion_id) errs.push('infusion_pct sin infusion_id');
      if (infusion_pct == null) errs.push('infusion_id sin infusion_pct');
      if (infusion_pct != null && (!Number.isFinite(infusion_pct) || infusion_pct <= 0 || infusion_pct > 100)) {
        errs.push('infusion_pct debe estar en (0, 100]');
      }
    }

    if (errs.length) {
      rowErrors.push({ index: idx, errors: errs });
      return;
    }

    const kg_green_expected = inputToGreen(kg_input_amount, processing_stage);
    cleaned.push({
      bache_code,
      reference_id,
      process_type,
      processing_stage,
      kg_cherry_input:     processing_stage === 'cereza'     ? kg_input_amount : null,
      kg_despulpado_input: processing_stage === 'despulpado' ? kg_input_amount : null,
      kg_dried_output:     processing_stage === 'seco'        ? kg_input_amount : null,
      kg_green_expected,
      fermentation_hours,
      start_date,
      notes,
      infusion_id,
      infusion_pct,
      variety_ids,
      created_by: session.role,
    });
  });

  if (rowErrors.length) {
    return badReq('Validation failed for one or more rows', 'VALIDATION_ERROR', { row_errors: rowErrors });
  }

  const sb = getSupabase();

  // ── Validar referencias existentes y activas (sólo las filas que la traen) ──
  const refIds = [...new Set(cleaned.map((o) => o.reference_id).filter(Boolean))];
  if (refIds.length > 0) {
    const { data: refs, error: refErr } = await sb
      .from('coffee_references').select('id, active').in('id', refIds);
    if (refErr) return serverErr('Reference lookup failed', refErr.message);
    const refMap = new Map((refs || []).map((r) => [r.id, r]));
    const badRefs = [];
    cleaned.forEach((o, idx) => {
      if (!o.reference_id) return; // opcional
      const r = refMap.get(o.reference_id);
      if (!r || !r.active) badRefs.push({ index: idx, reason: 'Unknown or inactive reference' });
    });
    if (badRefs.length) return badReq('Invalid references', 'INVALID_REFERENCE', { row_errors: badRefs });
  }

  // ── Validar bache_codes únicos vs BD ──
  const allCodes = cleaned.map((o) => o.bache_code);
  const { data: existing, error: existErr } = await sb
    .from('production_lots').select('bache_code').in('bache_code', allCodes);
  if (existErr) return serverErr('Lookup failed', existErr.message);
  if (existing && existing.length > 0) {
    const taken = new Set(existing.map((r) => (r.bache_code || '').toLowerCase()));
    const duplicates = cleaned
      .map((o, idx) => ({ idx, code: o.bache_code }))
      .filter((x) => taken.has(x.code.toLowerCase()));
    if (duplicates.length > 0) {
      return conflict(
        `Ya existe(n) lote(s) con esos códigos de bache: ${duplicates.map((d) => d.code).join(', ')}`,
        'BACHE_CODE_TAKEN',
        { row_errors: duplicates.map((d) => ({ index: d.idx, errors: ['bache_code ya existe'] })) },
      );
    }
  }

  // ── INSERT atómico de lotes + variedades ──
  const lotRows = cleaned.map((o) => ({
    bache_code: o.bache_code,
    reference_id: o.reference_id || null,
    process_type: o.process_type,
    processing_stage: o.processing_stage,
    kg_cherry_input: o.kg_cherry_input,
    kg_despulpado_input: o.kg_despulpado_input,
    kg_dried_output: o.kg_dried_output,
    kg_green_expected: o.kg_green_expected,
    fermentation_hours: o.fermentation_hours,
    start_date: o.start_date,
    notes: o.notes,
    infusion_id: o.infusion_id,
    infusion_pct: o.infusion_pct,
    created_by: o.created_by,
  }));

  const { data: insertedLots, error: insErr } = await sb
    .from('production_lots').insert(lotRows).select();
  if (insErr) {
    if (/bache_code/i.test(insErr.message) && /unique|duplicate/i.test(insErr.message)) {
      return conflict('Algún bache_code chocó con uno existente', 'BACHE_CODE_TAKEN');
    }
    return serverErr('Failed to create lots', insErr.message);
  }

  const varietyLinks = [];
  insertedLots.forEach((row, idx) => {
    const uniqueIds = [...new Set(cleaned[idx].variety_ids)];
    for (const variety_id of uniqueIds) {
      varietyLinks.push({ production_lot_id: row.id, variety_id });
    }
  });
  if (varietyLinks.length > 0) {
    const { error: vErr } = await sb.from('production_lot_varieties').insert(varietyLinks);
    if (vErr) {
      const ids = insertedLots.map((r) => r.id);
      await sb.from('production_lots').delete().in('id', ids);
      return serverErr('Failed to link varieties (rolled back)', vErr.message);
    }
  }

  return created({ lots: insertedLots });
});
