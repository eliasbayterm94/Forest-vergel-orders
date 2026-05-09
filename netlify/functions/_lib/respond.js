/**
 * Standard JSON response helper for Netlify Functions (classic handler).
 */

'use strict';

const baseHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...baseHeaders, ...extraHeaders },
    body: JSON.stringify(body),
  };
}

const ok        = (body, h)   => json(200, body, h);
const created   = (body, h)   => json(201, body, h);
const badReq    = (msg, code, extra) => json(400, { error: msg, code, ...(extra || {}) });
const unauth    = (msg = 'Unauthorized') => json(401, { error: msg, code: 'UNAUTHORIZED' });
const forbid    = (msg = 'Forbidden')    => json(403, { error: msg, code: 'FORBIDDEN' });
const notFound  = (msg = 'Not found')    => json(404, { error: msg, code: 'NOT_FOUND' });
const conflict  = (msg, code, extra)     => json(409, { error: msg, code, ...(extra || {}) });
const serverErr = (msg = 'Server error', detail) => json(500, { error: msg, code: 'SERVER_ERROR', detail });

function methodNotAllowed(allowed = []) {
  return json(405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }, { Allow: allowed.join(', ') });
}

function parseJson(event) {
  if (!event.body) return {};
  try { return JSON.parse(event.body); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { httpStatus: 400, code: 'INVALID_JSON' }); }
}

module.exports = {
  json, ok, created, badReq, unauth, forbid, notFound, conflict, serverErr,
  methodNotAllowed, parseJson,
};
