'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /email-log-list  (admin only)
 *   ?limit=50                     (default 50, max 200)
 *   ?event_type=demand_accepted   (optional filter)
 *   ?status=failed                (optional: sent | failed | dry_run)
 *
 * Devuelve los emails enviados (o intentados) ordenados por sent_at desc.
 * Util para confirmar que las notificaciones llegaron y debuggear fallos.
 */
exports.handler = requireAuth(['admin'], async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const q = event.queryStringParameters || {};

  const limit = Math.max(1, Math.min(200, Number(q.limit) || 50));

  const sb = getSupabase();
  let query = sb.from('email_log')
    .select('id, sent_at, event_type, to_address, subject, status, error_message, related_order_id')
    .order('sent_at', { ascending: false })
    .limit(limit);

  if (q.event_type) query = query.eq('event_type', q.event_type);
  if (q.status)     query = query.eq('status', q.status);

  const { data, error } = await query;
  if (error) return serverErr('Email log query failed', error.message);

  return ok({ emails: data || [] });
});
