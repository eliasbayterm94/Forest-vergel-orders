'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const {
  PUBLIC_COLS, toPublicUser, hashPassword,
  validateUsername, validatePassword, validateRole,
} = require('./_lib/users');
const { created, badReq, conflict, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /users-create  (admin)
 * Body: { username, password, role, full_name? }
 *
 * No es idempotente a propósito: si el usuario ya existe devolvemos
 * 409 en vez de pisarle la contraseña por accidente. Para cambiar la
 * clave de alguien existente se usa /users-update.
 */
exports.handler = requireAuth(['admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const uname = validateUsername(body && body.username);
  if (!uname.ok) return badReq(uname.error, uname.code);

  const pass = validatePassword(body && body.password);
  if (!pass.ok) return badReq(pass.error, pass.code);

  const role = validateRole(body && body.role);
  if (!role.ok) return badReq(role.error, role.code);

  let fullName = null;
  if (body && body.full_name != null) {
    fullName = String(body.full_name).trim().slice(0, 80) || null;
  }

  const sb = getSupabase();

  const { data: existing, error: lookupErr } = await sb
    .from('users').select('id').eq('username', uname.value).maybeSingle();
  if (lookupErr) return serverErr('Lookup failed', lookupErr.message);
  if (existing) {
    return conflict(`El usuario "${uname.value}" ya existe`, 'USERNAME_TAKEN');
  }

  const { data, error } = await sb
    .from('users')
    .insert({
      username:      uname.value,
      full_name:     fullName,
      password_hash: hashPassword(pass.value),
      role:          role.value,
      active:        true,
    })
    .select(PUBLIC_COLS)
    .single();

  if (error) {
    // Carrera contra el UNIQUE: otro admin lo creó entre el lookup y el insert.
    if (/duplicate key|unique constraint/i.test(error.message || '')) {
      return conflict(`El usuario "${uname.value}" ya existe`, 'USERNAME_TAKEN');
    }
    return serverErr('Insert failed', error.message);
  }
  return created({ user: toPublicUser(data) });
});
