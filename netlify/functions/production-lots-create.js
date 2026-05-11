'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { inputToGreen, INPUT_STAGE_DIVISORS } = require('./_lib/processYields');
const { PROCESS_TYPES, ORDER_STATUS } = require('./_lib/schema');
const { created, badReq, conflict, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /production-lots-create  (finca, admin)
 * Body:
 *   bache_code             string, unique (required)
 *   reference_id           uuid
 *   process_type           one of PROCESS_TYPES
 *   processing_stage       'cereza' | 'despulpado' | 'seco'
 *   kg_input_amount        number > 0          (the weight at the chosen stage)
 *   start_date             'YYYY-MM-DD'
 *   fermentation_hours     number >= 0 (optional)
 *   variety_ids            [uuid] (optional)
 *   notes                  string (optional)
 *   initial_assignments    [{ demand_order_id, kg_green_allocated }] (optional)
 *
 * Backwards-compat: if `kg_cherry_input` is sent without `processing_stage`,
 * it is treated as a 'cereza' lot (legacy behavior).
 *
 * The kg amount is stored in the column matching the stage:
 *   cereza      → kg_cherry_input
 *   despulpado  → kg_despulpado_input
 *   seco        → kg_dried_output
 *
 * kg_green_expected is computed via inputToGreen(amount, stage).
 *
 * If `initial_assignments` is provided, those allocations are created
 * after the lot insert (atomically chained — order's InProduction status
 * is promoted via the same path as POST /lot-assignments-create).
 */
exports.handler = requireAuth(['finca', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const errors = [];
  const bache_code = (body.bache_code == null ? '' : String(body.bache_code)).trim();
  const reference_id = body.reference_id;
  const process_type = body.process_type;

  // Backwards-compat: legacy callers send kg_cherry_input + no stage.
  let processing_stage = body.processing_stage;
  let kg_input_amount  = Number(body.kg_input_amount);
  if ((!processing_stage || !Number.isFinite(kg_input_amount) || kg_input_amount <= 0)
      && body.kg_cherry_input != null) {
    processing_stage = 'cereza';
    kg_input_amount  = Number(body.kg_cherry_input);
  }

  const start_date = body.start_date;
  const fermentation_hours = body.fermentation_hours == null ? null : Number(body.fermentation_hours);
  const variety_ids = Array.isArray(body.variety_ids) ? body.variety_ids : [];
  const notes = body.notes == null ? null : String(body.notes);
  const initial_assignments = Array.isArray(body.initial_assignments) ? body.initial_assignments : [];

  if (!bache_code) errors.push('bache_code required');
  else if (bache_code.length > 60) errors.push('bache_code too long (max 60 chars)');
  if (!reference_id) errors.push('reference_id required');
  if (!PROCESS_TYPES.includes(process_type)) errors.push('process_type invalid');
  if (!processing_stage || !INPUT_STAGE_DIVISORS[processing_stage]) {
    errors.push('processing_stage must be cereza, despulpado, or seco');
  }
  if (!Number.isFinite(kg_input_amount) || kg_input_amount <= 0) {
    errors.push('kg_input_amount must be > 0');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date || '')) errors.push('start_date must be YYYY-MM-DD');
  if (fermentation_hours != null && (!Number.isFinite(fermentation_hours) || fermentation_hours < 0))
    errors.push('fermentation_hours must be >= 0');
  if (errors.length) return badReq(errors.join('; '), 'VALIDATION_ERROR');

  const sb = getSupabase();
  const { data: refRow, error: refErr } = await sb
    .from('coffee_references').select('id, active').eq('id', reference_id).maybeSingle();
  if (refErr) return serverErr('Reference lookup failed', refErr.message);
  if (!refRow || !refRow.active) return badReq('Unknown or inactive reference', 'INVALID_REFERENCE');

  const kg_green_expected = inputToGreen(kg_input_amount, processing_stage);

  // Infusion (opcional): si viene infusion_id, infusion_pct debe ser > 0
  // y <= 100.
  let infusion_id = body.infusion_id || null;
  let infusion_pct = body.infusion_pct == null ? null : Number(body.infusion_pct);
  if (infusion_id || infusion_pct != null) {
    if (!infusion_id) errors.push('infusion_pct sin infusion_id');
    if (infusion_pct == null) errors.push('infusion_id sin infusion_pct');
    if (infusion_pct != null && (!Number.isFinite(infusion_pct) || infusion_pct <= 0 || infusion_pct > 100)) {
      errors.push('infusion_pct debe estar en (0, 100]');
    }
  }
  if (errors.length) return badReq(errors.join('; '), 'VALIDATION_ERROR');

  // Map the kg into the appropriate column based on the stage.
  const stageInsert = {
    kg_cherry_input:     processing_stage === 'cereza'     ? kg_input_amount : null,
    kg_despulpado_input: processing_stage === 'despulpado' ? kg_input_amount : null,
    kg_dried_output:     processing_stage === 'seco'        ? kg_input_amount : null,
  };

  const { data: lot, error: insErr } = await sb
    .from('production_lots').insert({
      bache_code,
      reference_id,
      process_type,
      processing_stage,
      ...stageInsert,
      kg_green_expected,
      fermentation_hours,
      start_date,
      notes,
      infusion_id,
      infusion_pct,
      created_by: session.role,
    }).select().single();
  if (insErr) {
    if (/bache_code/i.test(insErr.message) && /unique|duplicate/i.test(insErr.message)) {
      return conflict('Ya existe un lote con ese código de bache', 'BACHE_CODE_TAKEN');
    }
    return serverErr('Failed to create lot', insErr.message);
  }

  if (variety_ids.length > 0) {
    const rows = variety_ids.map((variety_id) => ({ production_lot_id: lot.id, variety_id }));
    const { error: vErr } = await sb.from('production_lot_varieties').insert(rows);
    if (vErr) return serverErr('Failed to link varieties', vErr.message);
  }

  // Optional initial assignments
  const assignmentResults = [];
  if (initial_assignments.length > 0) {
    const valid = initial_assignments.filter((a) => {
      const n = Number(a.kg_green_allocated);
      return a.demand_order_id && Number.isFinite(n) && n > 0;
    });
    if (valid.length > 0) {
      const rows = valid.map((a) => ({
        production_lot_id: lot.id,
        demand_order_id: a.demand_order_id,
        kg_green_allocated: Number(a.kg_green_allocated),
      }));
      const { data: createdAssigns, error: aErr } = await sb
        .from('lot_order_assignments').insert(rows).select();
      if (aErr) {
        // Roll back the lot to keep things consistent.
        await sb.from('production_lots').delete().eq('id', lot.id);
        if (/reference mismatch/i.test(aErr.message))    return conflict(aErr.message, 'REFERENCE_MISMATCH');
        if (/process_type mismatch/i.test(aErr.message)) return conflict(aErr.message, 'PROCESS_MISMATCH');

        // Sobrecupo: re-componer el mensaje en español con order_code.
        const m = /Total allocated kg \(([\d.]+)\) exceeds order kg_green_accepted \(([\d.]+)\) for order ([a-f0-9-]+)/i
          .exec(aErr.message);
        if (m) {
          const totalAfter = Number(m[1]);
          const accepted   = Number(m[2]);
          const orderId    = m[3];
          const overflow   = Math.round((totalAfter - accepted) * 100) / 100;
          const { data: o } = await sb
            .from('demand_orders').select('order_code').eq('id', orderId).maybeSingle();
          const code = (o && o.order_code) || orderId.slice(0, 8);
          const already = Math.round((totalAfter - rows.reduce((s, r) => s + Number(r.kg_green_allocated || 0), 0)) * 100) / 100;
          return conflict(
            `Pedido ${code} solo acepta ${accepted} kg verde y ya tiene ${already} asignados de otros lotes. ` +
            `La asignación que intentas excede en ${overflow} kg.`,
            'OVER_ALLOCATED',
          );
        }
        if (/exceeds order kg_green_accepted/i.test(aErr.message))
          return conflict(aErr.message, 'OVER_ALLOCATED');
        return serverErr('Assignment insert failed', aErr.message);
      }
      assignmentResults.push(...(createdAssigns || []));

      // Promote any Accepted/PartiallyAccepted orders to InProduction.
      const orderIds = [...new Set(valid.map((a) => a.demand_order_id))];
      for (const id of orderIds) {
        const { data: o } = await sb.from('demand_orders').select('id, status').eq('id', id).maybeSingle();
        if (o && (o.status === ORDER_STATUS.Accepted || o.status === ORDER_STATUS.PartiallyAccepted)) {
          await sb.from('demand_orders').update({
            status: ORDER_STATUS.InProduction,
            in_production_at: new Date().toISOString(),
          }).eq('id', id);
        }
      }
    }
  }

  return created({ lot, assignments: assignmentResults });
});
