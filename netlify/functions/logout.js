'use strict';

const { clearCookie } = require('./_lib/auth');
const { ok, methodNotAllowed } = require('./_lib/respond');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  return ok({ ok: true }, { 'Set-Cookie': clearCookie() });
};
