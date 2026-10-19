'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, badReq, notFound, conflict, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /suppliers-update  (admin)
 * Body: { id, fields: { name?, region?, active?, notes? } }
 *
 * `kind` is deliberately NOT editable: flipping own <-> third_party
 * would change how every past reception should have been costed, and
 * snapshots are frozen. Create a new supplier instead.
 */
const ALLOWED = new Set(['name', 'region', 'active', 'notes']);

exports.handler = requireAuth(['admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const id = body && body.id;
  if (!id) return badReq('id requerido', 'ID_REQUIRED');

  const fields = (body && body.fields) || {};
  if (fields.kind !== undefined) {
    return conflict(
      'El tipo de proveedor no se puede cambiar: cambiaría el costeo de todas sus recepciones pasadas, '
      + 'y los snapshots están congelados. Crea un proveedor nuevo.',
      'SUPPLIER_KIND_IMMUTABLE',
    );
  }

  const update = {};
  for (const k of Object.keys(fields)) {
    if (!ALLOWED.has(k)) continue;
    if (k === 'active') { update.active = !!fields.active; continue; }
    if (k === 'name') {
      const n = String(fields.name || '').trim();
      if (!n) return badReq('name no puede quedar vacío', 'NAME_REQUIRED');
      if (n.length > 120) return badReq('name muy largo', 'NAME_TOO_LONG');
      update.name = n; continue;
    }
    update[k] = fields[k] == null ? null : String(fields[k]).trim().slice(0, 500) || null;
  }
  if (Object.keys(update).length === 0) return badReq('Sin campos para actualizar', 'NO_FIELDS');

  const sb = getSupabase();
  const { data, error } = await sb
    .from('suppliers').update(update).eq('id', id)
    .select('id, name, kind, region, active, notes').maybeSingle();
  if (error) return serverErr('Update failed', error.message);
  if (!data) return notFound('Proveedor no encontrado');
  return ok({ supplier: data });
});
