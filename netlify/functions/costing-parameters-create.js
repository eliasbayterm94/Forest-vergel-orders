'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { created, badReq, conflict, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /costing-parameters-create  (admin)
 * Body: { effective_from, t1_per_kg_net, t2_per_kg_own_net,
 *         annual_mandate_cop?, annual_agricultural_cop?,
 *         budget_kg_net?, budget_kg_own_net?, notes? }
 *
 * A new version applies to dry exits on or after its effective_from
 * and never touches what already left — snapshots copy the rates in.
 *
 * There are no per-entry-stage percentages: T1 is charged flat on net
 * kg entering. The budget denominator must be stated the same way
 * (net kg entering, any stage) or the monthly close carries a
 * permanent bias; budget_kg_net is kept so that arithmetic is on the
 * record.
 */
exports.handler = requireAuth(['admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const effective_from = body && body.effective_from;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effective_from || '')) {
    return badReq('effective_from debe ser YYYY-MM-DD', 'INVALID_DATE');
  }

  const num = (v, label, { required = true } = {}) => {
    if (v == null || v === '') {
      if (required) return { err: `${label} requerido` };
      return { value: null };
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { err: `${label} debe ser un número >= 0` };
    return { value: n };
  };

  const t1 = num(body.t1_per_kg_net, 't1_per_kg_net');
  if (t1.err) return badReq(t1.err, 'INVALID_T1');
  const t2 = num(body.t2_per_kg_own_net, 't2_per_kg_own_net');
  if (t2.err) return badReq(t2.err, 'INVALID_T2');

  const optional = {};
  for (const [key, label] of [
    ['annual_mandate_cop', 'annual_mandate_cop'],
    ['annual_agricultural_cop', 'annual_agricultural_cop'],
    ['budget_kg_net', 'budget_kg_net'],
    ['budget_kg_own_net', 'budget_kg_own_net'],
  ]) {
    const r = num(body[key], label, { required: false });
    if (r.err) return badReq(r.err, 'INVALID_BUDGET');
    optional[key] = r.value;
  }
  // The table requires these to be > 0 when present.
  for (const k of ['budget_kg_net', 'budget_kg_own_net']) {
    if (optional[k] !== null && !(optional[k] > 0)) {
      return badReq(`${k} debe ser > 0`, 'INVALID_BUDGET');
    }
  }

  const sb = getSupabase();
  const { data, error } = await sb
    .from('costing_parameters')
    .insert({
      effective_from,
      t1_per_kg_net: t1.value,
      t2_per_kg_own_net: t2.value,
      ...optional,
      notes: body.notes ? String(body.notes).trim().slice(0, 1000) || null : null,
      created_by: (session && (session.username || session.role)) || null,
    })
    .select('*').single();

  if (error) {
    if (/duplicate key|unique constraint/i.test(error.message || '')) {
      return conflict(
        `Ya existe una versión de tarifas vigente desde ${effective_from}. `
        + 'Edita esa versión o elige otra fecha.',
        'EFFECTIVE_FROM_TAKEN',
      );
    }
    return serverErr('Insert failed', error.message);
  }
  return created({ costing_parameters: data });
});
