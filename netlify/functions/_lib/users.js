/**
 * Usuarios — hashing, validación y lookup contra la tabla `users`.
 *
 * El login es username + password. El rol sale de la fila del usuario,
 * no de lo que mande el cliente.
 */

'use strict';

const bcrypt = require('bcryptjs');

// OJO: resolución diferida, NO `const { getSupabase } = require(...)`.
// El harness de tests parchea supabase.getSupabase después de cargar
// este módulo; desestructurar acá congelaría la referencia original.
const supa = require('./supabase');

const ROUNDS = 12;
const ROLES = ['forest', 'finca', 'admin'];

const USERNAME_RE = /^[a-z0-9._-]+$/i;
const USERNAME_MIN = 3;
const USERNAME_MAX = 40;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;   // bcrypt trunca a 72 bytes; rechazamos antes de truncar en silencio

// Columnas pedidas a PostgREST. password_hash NUNCA sale de acá.
const PUBLIC_COLS = 'id, username, full_name, role, active, last_login_at, created_at';

/**
 * Whitelist explícita antes de responder. Redundante con PUBLIC_COLS a
 * propósito: si alguien agrega una columna sensible al select, o cambia
 * la query, el hash sigue sin poder salir por la respuesta HTTP.
 */
function toPublicUser(row) {
  if (!row) return null;
  return {
    id:            row.id,
    username:      row.username,
    full_name:     row.full_name ?? null,
    role:          row.role,
    active:        row.active,
    last_login_at: row.last_login_at ?? null,
    created_at:    row.created_at ?? null,
  };
}

/**
 * Hash bcrypt compatible con pgcrypto crypt(..., gen_salt('bf', 12)).
 */
function hashPassword(password) {
  return bcrypt.hashSync(password, ROUNDS);
}

/**
 * Valida un username. Devuelve { ok, value } o { ok:false, error, code }.
 */
function validateUsername(raw) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return { ok: false, error: 'Usuario requerido', code: 'USERNAME_REQUIRED' };
  if (value.length < USERNAME_MIN) {
    return { ok: false, error: `Usuario muy corto (mínimo ${USERNAME_MIN})`, code: 'USERNAME_TOO_SHORT' };
  }
  if (value.length > USERNAME_MAX) {
    return { ok: false, error: `Usuario muy largo (máximo ${USERNAME_MAX})`, code: 'USERNAME_TOO_LONG' };
  }
  if (!USERNAME_RE.test(value)) {
    return { ok: false, error: 'Usuario solo admite letras, números, punto, guion y guion bajo', code: 'USERNAME_INVALID' };
  }
  return { ok: true, value };
}

/**
 * Valida una contraseña nueva.
 */
function validatePassword(raw) {
  if (typeof raw !== 'string' || !raw) {
    return { ok: false, error: 'Contraseña requerida', code: 'PASSWORD_REQUIRED' };
  }
  if (raw.length < PASSWORD_MIN) {
    return { ok: false, error: `Contraseña muy corta (mínimo ${PASSWORD_MIN} caracteres)`, code: 'PASSWORD_TOO_SHORT' };
  }
  if (Buffer.byteLength(raw, 'utf8') > PASSWORD_MAX) {
    return { ok: false, error: `Contraseña muy larga (máximo ${PASSWORD_MAX} bytes)`, code: 'PASSWORD_TOO_LONG' };
  }
  return { ok: true, value: raw };
}

function validateRole(raw) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!ROLES.includes(value)) {
    return { ok: false, error: `Rol inválido (usa: ${ROLES.join(', ')})`, code: 'ROLE_INVALID' };
  }
  return { ok: true, value };
}

/**
 * Busca un usuario activo por username, incluyendo el hash.
 * Devuelve null si no existe, está inactivo, o la tabla no existe todavía.
 * `tableMissing` en el resultado permite al login caer al modo legacy.
 */
async function findActiveUserForLogin(username) {
  const sb = supa.getSupabase();
  const { data, error } = await sb
    .from('users')
    .select('id, username, full_name, password_hash, role, active')
    .eq('username', username)
    .eq('active', true)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) return { tableMissing: true, user: null };
    throw new Error(`Users lookup failed: ${error.message}`);
  }
  return { tableMissing: false, user: data || null };
}

/**
 * ¿Existe al menos un usuario activo? Define si el login legacy por
 * env vars sigue habilitado (ver 0048_users.sql).
 */
async function hasAnyActiveUser() {
  const sb = supa.getSupabase();
  const { data, error } = await sb
    .from('users')
    .select('id')
    .eq('active', true)
    .limit(1);

  if (error) {
    if (isMissingTable(error)) return false;
    throw new Error(`Users probe failed: ${error.message}`);
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * La tabla `users` no existe (migración 0048 sin aplicar). PostgREST
 * responde 42P01 / "does not exist" según versión.
 */
function isMissingTable(error) {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  return /relation .*users.* does not exist|could not find the table/i.test(error.message || '');
}

/**
 * Marca el último login. Best-effort: un fallo acá no debe tumbar el login.
 */
async function touchLastLogin(id) {
  try {
    const sb = supa.getSupabase();
    await sb.from('users').update({ last_login_at: new Date().toISOString() }).eq('id', id);
  } catch { /* no bloquea el login */ }
}

module.exports = {
  ROLES, ROUNDS, PUBLIC_COLS, toPublicUser,
  PASSWORD_MIN, USERNAME_MIN, USERNAME_MAX,
  hashPassword,
  validateUsername, validatePassword, validateRole,
  findActiveUserForLogin, hasAnyActiveUser, touchLastLogin,
  isMissingTable,
};
