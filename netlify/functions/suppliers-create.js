'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
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

  const { data, error } = await sb
    .from('suppliers')
    .insert({ name, kind, region, notes, active: true })
    .select('id, name, kind, region, active, notes').single();
  if (error) return serverErr('Insert failed', error.message);
  return created({ supplier: data, created: true });
});
