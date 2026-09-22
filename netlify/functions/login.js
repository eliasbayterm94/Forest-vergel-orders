'use strict';

const { authenticate, sign, buildCookie } = require('./_lib/auth');
const { ok, badReq, unauth, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /login
 * Body: { username, password }
 *
 * El rol sale de la fila del usuario en la base, no del cliente.
 *
 * Compat: se sigue aceptando { role, password } — durante el modo
 * legacy (sin usuarios creados) el rol funciona como usuario, y los
 * clientes viejos en caché no se rompen tras el deploy.
 */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);

  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const username = (body && (body.username || body.role)) || '';
  const password = body && body.password;

  if (typeof username !== 'string' || !username.trim()) {
    return badReq('Usuario requerido', 'USERNAME_REQUIRED');
  }
  if (typeof password !== 'string' || !password) {
    return badReq('Contraseña requerida', 'PASSWORD_REQUIRED');
  }

  let session;
  try {
    session = await authenticate(username, password);
  } catch (e) {
    return serverErr('No se pudo verificar las credenciales', e.message);
  }
  if (!session) return unauth('Usuario o contraseña incorrectos');

  const token = sign({ role: session.role, username: session.username, uid: session.uid });
  return ok(
    { role: session.role, username: session.username, name: session.name },
    { 'Set-Cookie': buildCookie(token) },
  );
};
