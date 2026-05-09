'use strict';

const { getSession } = require('./_lib/auth');
const { ok, unauth, methodNotAllowed } = require('./_lib/respond');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const session = getSession(event);
  if (!session) return unauth();
  return ok({ role: session.role, exp: session.exp });
};
