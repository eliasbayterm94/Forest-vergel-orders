'use strict';

const { verifyPassword, sign, buildCookie, ROLES } = require('./_lib/auth');
const { ok, badReq, unauth, methodNotAllowed, parseJson } = require('./_lib/respond');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);

  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const { role, password } = body || {};
  if (!ROLES.includes(role)) return badReq('Invalid role', 'INVALID_ROLE');
  if (typeof password !== 'string' || !password) return badReq('Password required', 'PASSWORD_REQUIRED');

  const okPass = await verifyPassword(role, password);
  if (!okPass) return unauth('Invalid credentials');

  const token = sign({ role });
  return ok({ role }, { 'Set-Cookie': buildCookie(token) });
};
