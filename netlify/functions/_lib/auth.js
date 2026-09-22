/**
 * Auth — login por usuario individual con cookie firmada (HMAC).
 *
 * Usuarios y contraseñas viven en la tabla `users` de Supabase
 * (migración 0048). El rol — forest | finca | admin — sale de la fila
 * del usuario, nunca de lo que mande el cliente.
 *
 * Cambiar una clave es un UPDATE en la base; no requiere redeploy.
 *
 * MODO LEGACY (compatibilidad): mientras no exista ningún usuario
 * activo — o la migración 0048 no esté aplicada — el login acepta las
 * claves por rol de las env vars FOREST/FINCA/ADMIN_PASSWORD_HASH,
 * usando el nombre del rol como usuario. Así el sistema nunca queda
 * inaccesible por el orden entre migración y deploy. En cuanto se crea
 * el primer usuario activo, este camino deja de usarse.
 *
 * On successful login we set an HttpOnly cookie containing a token of
 * the form  base64url(payload).base64url(hmac)  signed with JWT_SECRET.
 * No external JWT library — Node crypto only.
 */

'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const users = require('./users');

const COOKIE_NAME = 'fvb_session';
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

const ROLES = ['forest', 'finca', 'admin'];

// Hash real de una cadena aleatoria descartada. Se compara contra él
// cuando el usuario no existe, para que un atacante no distinga
// "usuario inexistente" de "clave incorrecta" por el tiempo de
// respuesta (bcrypt tarda ~300ms; un return temprano tardaría ~0ms).
const DUMMY_HASH = '$2a$12$po.p0Ge7D/ab5ReGDGGtqulXvx.QiEbCv5kkAUdTb1n1GOw54A9ge';

function getRoleHash(role) {
  switch (role) {
    case 'forest': return process.env.FOREST_PASSWORD_HASH;
    case 'finca':  return process.env.FINCA_PASSWORD_HASH;
    case 'admin':  return process.env.ADMIN_PASSWORD_HASH;
    default: return null;
  }
}

/** Login legacy por rol contra las env vars. Ver nota de arriba. */
async function verifyPassword(role, password) {
  if (!ROLES.includes(role)) return false;
  const hash = getRoleHash(role);
  if (!hash || typeof password !== 'string' || !password) return false;
  return bcrypt.compare(password, hash);
}

/**
 * Autentica username + password.
 *
 * Devuelve el payload de sesión { uid, username, role, name } o null
 * si las credenciales no sirven. Nunca revela si el usuario existe.
 */
async function authenticate(username, password) {
  if (typeof username !== 'string' || !username) return null;
  if (typeof password !== 'string' || !password) return null;
  const uname = username.trim().toLowerCase();

  const { tableMissing, user } = await users.findActiveUserForLogin(uname);

  if (user) {
    const okPass = await bcrypt.compare(password, user.password_hash);
    if (!okPass) return null;
    await users.touchLastLogin(user.id);
    return {
      uid:      user.id,
      username: user.username,
      role:     user.role,
      name:     user.full_name || null,
    };
  }

  // Sin usuario: ¿estamos todavía en modo legacy?
  const legacyOpen = tableMissing || !(await users.hasAnyActiveUser());
  if (legacyOpen) {
    if (await verifyPassword(uname, password)) {
      return { uid: null, username: uname, role: uname, name: null, legacy: true };
    }
    return null;
  }

  // Tabla poblada y el usuario no existe: quemamos el mismo tiempo que
  // habría costado verificar una clave real.
  await bcrypt.compare(password, DUMMY_HASH);
  return null;
}

// ---- token signing ----
function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error('JWT_SECRET env var missing or too short (>=32 chars required)');
  }
  return s;
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(payloadObj, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...payloadObj, iat: now, exp: now + ttlSeconds };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', getSecret()).update(payloadB64).digest();
  return `${payloadB64}.${b64urlEncode(sig)}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  const expected = crypto.createHmac('sha256', getSecret()).update(payloadB64).digest();
  let provided;
  try { provided = b64urlDecode(sigB64); } catch { return null; }
  if (provided.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(provided, expected)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')); }
  catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ---- cookie helpers ----
function buildCookie(token, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${ttlSeconds}`,
  ];
  // Netlify production is HTTPS; locally Netlify Dev serves HTTP, so omit Secure when NODE_ENV=development
  if (process.env.NODE_ENV !== 'development') attrs.push('Secure');
  return attrs.join('; ');
}

function clearCookie() {
  const attrs = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (process.env.NODE_ENV !== 'development') attrs.push('Secure');
  return attrs.join('; ');
}

function readCookie(event) {
  const header = event.headers && (event.headers.cookie || event.headers.Cookie);
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE_NAME) return v.join('=');
  }
  return null;
}

/**
 * Returns the verified session payload {role, iat, exp} or null.
 */
function getSession(event) {
  const tok = readCookie(event);
  return verify(tok);
}

/**
 * Wraps a handler so it requires a session, optionally restricted to roles.
 * Usage: exports.handler = requireAuth(async (event, ctx, session) => ...)
 *        exports.handler = requireAuth(['finca','admin'], async (...) => ...)
 */
function requireAuth(rolesOrHandler, maybeHandler) {
  let allowed, handler;
  if (typeof rolesOrHandler === 'function') {
    allowed = null; handler = rolesOrHandler;
  } else {
    allowed = rolesOrHandler; handler = maybeHandler;
  }
  return async (event, ctx) => {
    const session = getSession(event);
    if (!session) {
      return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }) };
    }
    if (allowed && !allowed.includes(session.role)) {
      return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Forbidden', code: 'FORBIDDEN' }) };
    }
    return handler(event, ctx, session);
  };
}

module.exports = {
  ROLES, COOKIE_NAME, DEFAULT_TTL_SECONDS,
  authenticate, verifyPassword, sign, verify, buildCookie, clearCookie, readCookie,
  getSession, requireAuth,
};
