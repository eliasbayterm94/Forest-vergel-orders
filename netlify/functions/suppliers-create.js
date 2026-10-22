'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { isMissingColumn } = require('./_lib/costingData');
const { created, ok, badReq, json, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /suppliers-create  (admin, finca)
 * Body: { name, kind: 'own'|'third_party', region?, notes? }
 *
 * Idempotent on name, like the other admin catalogues: an existing
 * supplier comes back and is reactivated if it was off.
 *
 * The farm can register a new third party on the spot — cherry arrives
 * from a supplier nobody set up yet, and blocking the weighing on an
 * admin call is friction that loses the reception.
 *
 * It cannot create an 'own' supplier, though: kind drives the costing
 * path ('own' costs at T2, a third party at the price paid), so a
 * mislabelled supplier would cost purchased cherry at the farm's
 * agricultural rate. That stays with admin.
 */
const KINDS = new Set(['own', 'third_party']);

exports.handler = requireAuth(['admin', 'finca'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const name = (body && typeof body.name === 'string') ? body.name.trim() : '';
  if (!name) return badReq('name requerido', 'NAME_REQUIRED');
  if (name.length > 120) return badReq('name muy largo (máx 120)', 'NAME_TOO_LONG');

  const kind = body && body.kind;
  if (!KINDS.has(kind)) return badReq("kind debe ser 'own' o 'third_party'", 'KIND_INVALID');

  // Enforced here, not only hidden in the UI: an 'own' supplier changes
  // how every lot fed by it is costed.
  const isFarmOnly = session && session.role === 'finca';
  if (isFarmOnly && kind !== 'third_party') {
    return json(403, { error: 'Solo un admin puede crear un proveedor propio', code: 'OWN_KIND_REQUIRES_ADMIN' });
  }

  const region = body && body.region ? String(body.region).trim().slice(0, 80) || null : null;

  // Negotiated floater franchise: only what exceeds it gets discounted.
  // Suggestion aid only — it never enters the cost of a reception.
  let floater_franchise_pct = null;
  if (body && body.floater_franchise_pct != null && body.floater_franchise_pct !== '') {
    floater_franchise_pct = Number(body.floater_franchise_pct);
    if (!Number.isFinite(floater_franchise_pct) || floater_franchise_pct < 0 || floater_franchise_pct > 1) {
      return badReq('floater_franchise_pct debe ser una fracción entre 0 y 1 (0.05 = 5%)', 'INVALID_FRANCHISE');
    }
  }
  const notes  = body && body.notes  ? String(body.notes).trim().slice(0, 500) || null : null;

  const sb = getSupabase();

  const { data: existing, error: lookErr } = await sb
    .from('suppliers').select('id, name, kind, region, active').eq('name', name).maybeSingle();
  if (lookErr) return serverErr('Lookup failed', lookErr.message);
  if (existing) {
    // Same reason as above: the farm must not flip an 'own' supplier
    // back on, which would silently reopen the T2 path.
    if (isFarmOnly && existing.kind !== 'third_party') {
      return json(403, { error: 'Ese proveedor es propio; pídele a un admin que lo active', code: 'OWN_KIND_REQUIRES_ADMIN' });
    }
    if (!existing.active) {
      const { data: on, error: upErr } = await sb
        .from('suppliers').update({ active: true }).eq('id', existing.id)
        .select('id, name, kind, region, active').single();
      if (upErr) return serverErr('Reactivate failed', upErr.message);
      return ok({ supplier: on, created: false });
    }
    return ok({ supplier: existing, created: false });
  }

  const core = { name, kind, region, notes, active: true };
  const CORE_COLS = 'id, name, kind, region, active, notes';

  let { data, error } = await sb
    .from('suppliers')
    .insert({ ...core, floater_franchise_pct })
    .select(`${CORE_COLS}, floater_franchise_pct`).single();
  // Migration 0054 pending: register the supplier anyway. Blocking it
  // would block the reception that needed it.
  if (error && isMissingColumn(error, ['floater_franchise_pct'])) {
    ({ data, error } = await sb.from('suppliers').insert(core).select(CORE_COLS).single());
  }
  if (error) return serverErr('Insert failed', error.message);
  return created({ supplier: data, created: true });
});
