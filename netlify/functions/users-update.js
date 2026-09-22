'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const {
  PUBLIC_COLS, toPublicUser, hashPassword,
  validatePassword, validateRole,
} = require('./_lib/users');
const { ok, badReq, notFound, conflict, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');

/**
 * POST /users-update  (admin)
 * Body: { id, fields: { full_name?, role?, active?, password? } }
 *
 * `password` resetea la contraseña (es lo que se usa cuando alguien la
 * olvida). No pedimos la clave anterior: es una acción de admin.
 *
 * No borramos usuarios — se desactivan. Los tags de auditoría
 * históricos referencian el nombre, igual que en `operators`.
 *
 * Guarda de seguridad: no se permite dejar el sistema sin ningún admin
 * activo (desactivando o degradando al último). Eso dejaría a todo el
 * mundo afuera de /admin/config sin forma de volver desde la UI.
 */
const ALLOWED = new Set(['full_name', 'role', 'active', 'password']);

exports.handler = requireAuth(['admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const id = body && body.id;
  if (!id) return badReq('id required', 'ID_REQUIRED');

  const fields = (body && body.fields) || {};
  const update = {};

  for (const k of Object.keys(fields)) {
    if (!ALLOWED.has(k)) continue;

    if (k === 'password') {
      const pass = validatePassword(fields.password);
      if (!pass.ok) return badReq(pass.error, pass.code);
      update.password_hash = hashPassword(pass.value);
      continue;
    }
    if (k === 'role') {
      const role = validateRole(fields.role);
      if (!role.ok) return badReq(role.error, role.code);
      update.role = role.value;
      continue;
    }
    if (k === 'active') { update.active = !!fields.active; continue; }
    if (k === 'full_name') {
      update.full_name = fields.full_name == null
        ? null
        : (String(fields.full_name).trim().slice(0, 80) || null);
    }
  }

  if (Object.keys(update).length === 0) return badReq('No updatable fields', 'NO_FIELDS');

  const sb = getSupabase();

  const { data: target, error: lookupErr } = await sb
    .from('users').select('id, username, role, active').eq('id', id).maybeSingle();
  if (lookupErr) return serverErr('Lookup failed', lookupErr.message);
  if (!target) return notFound('Usuario no encontrado');

  // ¿Este cambio quita al último admin activo?
  const losesAdmin = target.role === 'admin' && target.active
    && (update.active === false || (update.role != null && update.role !== 'admin'));

  if (losesAdmin) {
    const { data: others, error: countErr } = await sb
      .from('users').select('id')
      .eq('role', 'admin').eq('active', true).neq('id', id);
    if (countErr) return serverErr('Admin check failed', countErr.message);
    if (!others || others.length === 0) {
      return conflict(
        'No se puede dejar el sistema sin ningún admin activo. Crea o activa otro admin primero.',
        'LAST_ADMIN',
      );
    }
  }

  const { data, error } = await sb
    .from('users').update(update).eq('id', id)
    .select(PUBLIC_COLS).maybeSingle();
  if (error) return serverErr('Update failed', error.message);
  if (!data) return notFound('Usuario no encontrado');

  return ok({ user: toPublicUser(data), password_changed: update.password_hash != null });
});
