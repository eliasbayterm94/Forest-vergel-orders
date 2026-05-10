'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /audit-log-list  (admin)
 *   ?entity_type=demand_orders   (optional)
 *   ?entity_id=<uuid|text>       (optional)
 *   ?since=2026-05-01T00:00:00Z  (optional, ISO)
 *   ?limit=50                    (default 50, max 200)
 *
 * Para cada fila adjunta un objeto `changed_fields` que es la
 * diferencia compacta {key: [before, after]} sobre las claves que
 * cambiaron, ignorando ruido conocido (updated_at, created_at).
 */
const NOISE_KEYS = new Set(['updated_at', 'created_at']);

exports.handler = requireAuth(['admin'], async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const q = event.queryStringParameters || {};

  const sb = getSupabase();
  let query = sb.from('audit_log')
    .select('id, at, entity_type, entity_id, action, actor, before_json, after_json')
    .order('at', { ascending: false });

  if (q.entity_type) query = query.eq('entity_type', q.entity_type);
  if (q.entity_id)   query = query.eq('entity_id', q.entity_id);
  if (q.since)       query = query.gte('at', q.since);

  const limit = Math.max(1, Math.min(200, Number(q.limit) || 50));
  query = query.limit(limit);

  const { data, error } = await query;
  if (error) return serverErr('Audit log query failed', error.message);

  const events = (data || []).map((r) => ({
    id: r.id,
    at: r.at,
    entity_type: r.entity_type,
    entity_id:   r.entity_id,
    action:      r.action,
    actor:       r.actor,
    changed_fields: diffJson(r.before_json, r.after_json),
  }));
  return ok({ events });
});

function diffJson(before, after) {
  if (!before && !after) return {};
  if (!before)         return summarize(after, 'after');
  if (!after)          return summarize(before, 'before');
  const out = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (NOISE_KEYS.has(k)) continue;
    const a = before[k];
    const b = after[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = [a, b];
  }
  return out;
}

function summarize(obj, side) {
  // Para INSERT (no hay before) o DELETE (no hay after) listamos las
  // claves no-ruido como cambio "creado" o "borrado".
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (NOISE_KEYS.has(k)) continue;
    out[k] = side === 'after' ? [null, v] : [v, null];
  }
  return out;
}
