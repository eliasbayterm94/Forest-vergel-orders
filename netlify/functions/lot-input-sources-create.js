'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { getPoolState } = require('./_lib/costingData');
const { quoteDraw, receptionNetKg, receptionAmountPaid } = require('./_lib/costPool');
const { created, badReq, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /lot-input-sources-create  (finca, admin)
 * Body: { production_lot_id, cost_basis, kg, entry_stage,
 *         reception_id?, pool_key?, notes? }
 *
 * Records where a lot's material came from, and FREEZES the purchase
 * price at this moment — the price is a fact, unlike T1/T2, which are
 * tariffs resolved later at dry exit.
 *
 * Deliberately a separate endpoint rather than a change to
 * production-lots-create: today's lot creation keeps working exactly as
 * it does, with zero risk to the operation. A lot whose source was not
 * recorded simply cannot be costed, and shows up in the
 * "lots without an input source" report instead of failing silently.
 *
 * cost_basis decides what is needed:
 *   purchase_identified — reception_id; price from that reception
 *   purchase_pool       — pool_key; price = the pool's weighted average now
 *   own                 — nothing; T2 applies at dry exit
 *   byproduct           — nothing; zero cost by policy
 *
 * A pool without enough balance does NOT block the draw: ops decided
 * it goes through with an alert, because blocking a batch over an
 * un-keyed invoice is how people stop using the system. The response
 * carries `warning` for the UI to show.
 */
const BASES = new Set(['purchase_identified', 'purchase_pool', 'own', 'byproduct']);
const STAGES = new Set(['cereza', 'despulpado', 'seco']);

exports.handler = requireAuth(['finca', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const lotId = body && body.production_lot_id;
  if (!lotId) return badReq('production_lot_id requerido', 'LOT_ID_REQUIRED');

  const cost_basis = body && body.cost_basis;
  if (!BASES.has(cost_basis)) {
    return badReq(`cost_basis debe ser uno de: ${[...BASES].join(', ')}`, 'INVALID_BASIS');
  }

  const kg = Number(body && body.kg);
  if (!Number.isFinite(kg) || kg <= 0) return badReq('kg debe ser > 0', 'INVALID_KG');

  const entry_stage = body && body.entry_stage;
  if (!STAGES.has(entry_stage)) return badReq('entry_stage inválido', 'INVALID_STAGE');

  const sb = getSupabase();

  const { data: lot, error: lotErr } = await sb
    .from('production_lots').select('id, bache_code, lot_code, status').eq('id', lotId).maybeSingle();
  if (lotErr) return serverErr('Lookup failed', lotErr.message);
  if (!lot) return notFound('Bache no encontrado');

  let purchase_cost_per_kg = null;
  let pool_key = null;
  let reception_id = null;
  let warning = null;

  if (cost_basis === 'purchase_identified') {
    reception_id = body.reception_id;
    if (!reception_id) return badReq('reception_id requerido para compra identificada', 'RECEPTION_REQUIRED');

    const { data: rec, error: recErr } = await sb
      .from('cherry_receptions')
      .select('id, reception_code, kg_gross, amount_paid_cop, price_per_kg, discount_pct')
      .eq('id', reception_id).maybeSingle();
    if (recErr) return serverErr('Lookup failed', recErr.message);
    if (!rec) return badReq('Recepción no encontrada', 'RECEPTION_NOT_FOUND');
    const paid = receptionAmountPaid(rec);
    if (paid == null) {
      return badReq(
        `La recepción ${rec.reception_code} no tiene precio: es café propio, usa cost_basis "own".`,
        'RECEPTION_HAS_NO_PRICE',
      );
    }

    const { data: bps, error: bpErr } = await sb
      .from('lot_byproducts').select('kg').eq('source_reception_id', reception_id);
    if (bpErr) return serverErr('Lookup failed', bpErr.message);

    // Cost per NET kg: the whole amount paid divided by the usable
    // coffee, so the by-product carries none of it.
    const net = receptionNetKg(rec, bps || []);
    if (!(net > 0)) {
      return badReq(`La recepción ${rec.reception_code} no tiene kg netos utilizables.`, 'RECEPTION_NO_NET');
    }
    purchase_cost_per_kg = Math.round((Number(paid) / net) * 10000) / 10000;

  } else if (cost_basis === 'purchase_pool') {
    pool_key = body.pool_key ? String(body.pool_key).trim().toLowerCase() : '';
    if (!pool_key) return badReq('pool_key requerido para compra por pool', 'POOL_KEY_REQUIRED');

    let state;
    try { state = await getPoolState(sb, pool_key); }
    catch (e) { return serverErr('Pool lookup failed', e.message); }

    if (!(Number(state.total_received_kg) > 0)) {
      return badReq(
        `El pool "${pool_key}" no tiene ninguna recepción registrada. Registra la recepción primero.`,
        'POOL_EMPTY',
      );
    }

    const quote = quoteDraw(state, kg);
    purchase_cost_per_kg = quote.cost_per_kg;
    if (quote.short) {
      warning = `El pool "${pool_key}" queda en negativo: tiene ${state.kg_on_hand} kg registrados `
              + `y se consumieron ${kg} kg. Se cobró al último promedio conocido `
              + `(${quote.cost_per_kg} COP/kg). Revisa si falta cargar una recepción.`;
    }
  }

  const { data, error } = await sb
    .from('lot_input_sources')
    .insert({
      production_lot_id: lotId,
      reception_id, pool_key, kg, entry_stage, cost_basis,
      purchase_cost_per_kg,
      notes: body.notes ? String(body.notes).trim().slice(0, 500) || null : null,
      created_by: (session && (session.username || session.role)) || null,
    })
    .select('*').single();
  if (error) return serverErr('No se pudo registrar la fuente de materia', error.message);

  return created({ input_source: data, warning });
});
