// Login por usuario individual contra la tabla `users` (migración
// 0048), incluyendo el modo legacy por env vars mientras no exista
// ningún usuario activo.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createFakeSupabase } = require('./helpers/fake-supabase');
const { loadHandler, setFake, parseRes } = require('./helpers/fn-harness');
const { verify, COOKIE_NAME } = require('../netlify/functions/_lib/auth');

// rounds=4: compare funciona con cualquier costo y mantiene el test rápido.
const hash = (pw) => bcrypt.hashSync(pw, 4);

function loginEvent(body) {
  return {
    httpMethod: 'POST',
    headers: {},
    body: body != null ? JSON.stringify(body) : null,
    queryStringParameters: {},
  };
}

function cookieToken(res) {
  const raw = res.headers['Set-Cookie'] || '';
  const m = raw.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return m ? m[1] : null;
}

const USERS = [
  { id: 'u1', username: 'elias',  full_name: 'Elias Bayter', password_hash: hash('secreta123'), role: 'admin',  active: true },
  { id: 'u2', username: 'juan',   full_name: 'Juan Pérez',   password_hash: hash('fincapass1'), role: 'finca',  active: true },
  { id: 'u3', username: 'antigua', full_name: null,          password_hash: hash('loquesea11'), role: 'forest', active: false },
];

const handler = loadHandler('login', createFakeSupabase({ users: USERS }));

test('login válido devuelve el rol de la fila y firma la cookie', async () => {
  setFake(createFakeSupabase({ users: USERS }));
  const res = await handler(loginEvent({ username: 'elias', password: 'secreta123' }));
  const { status, body } = parseRes(res);

  assert.equal(status, 200);
  assert.equal(body.role, 'admin');
  assert.equal(body.username, 'elias');

  const payload = verify(cookieToken(res));
  assert.equal(payload.role, 'admin');
  assert.equal(payload.username, 'elias');
  assert.equal(payload.uid, 'u1');
});

test('el rol sale de la base, no de lo que manda el cliente', async () => {
  setFake(createFakeSupabase({ users: USERS }));
  // juan es finca; intenta escalar pidiendo admin en el body.
  const res = await handler(loginEvent({ username: 'juan', password: 'fincapass1', role: 'admin' }));
  const { status, body } = parseRes(res);

  assert.equal(status, 200);
  assert.equal(body.role, 'finca');
  assert.equal(verify(cookieToken(res)).role, 'finca');
});

test('contraseña incorrecta devuelve 401', async () => {
  setFake(createFakeSupabase({ users: USERS }));
  const res = await handler(loginEvent({ username: 'elias', password: 'equivocada' }));
  assert.equal(parseRes(res).status, 401);
});

test('usuario inexistente devuelve 401 sin revelar que no existe', async () => {
  setFake(createFakeSupabase({ users: USERS }));
  const res = await handler(loginEvent({ username: 'fantasma', password: 'secreta123' }));
  const { status, body } = parseRes(res);
  assert.equal(status, 401);
  assert.match(body.error, /Usuario o contraseña/);
});

test('usuario desactivado no puede entrar', async () => {
  setFake(createFakeSupabase({ users: USERS }));
  const res = await handler(loginEvent({ username: 'antigua', password: 'loquesea11' }));
  assert.equal(parseRes(res).status, 401);
});

test('username es case-insensitive y tolera espacios', async () => {
  setFake(createFakeSupabase({ users: USERS }));
  const res = await handler(loginEvent({ username: '  Elias  ', password: 'secreta123' }));
  assert.equal(parseRes(res).status, 200);
});

test('falta el usuario o la contraseña → 400', async () => {
  setFake(createFakeSupabase({ users: USERS }));
  assert.equal(parseRes(await handler(loginEvent({ password: 'x' }))).status, 400);
  assert.equal(parseRes(await handler(loginEvent({ username: 'elias' }))).status, 400);
});

test('GET no está permitido', async () => {
  setFake(createFakeSupabase({ users: USERS }));
  const res = await handler({ ...loginEvent(null), httpMethod: 'GET' });
  assert.equal(parseRes(res).status, 405);
});

// ── Modo legacy ───────────────────────────────────────────────────
// Sin usuarios activos, el login acepta las claves por rol de las env
// vars usando el nombre del rol como usuario. Evita quedarse afuera
// según el orden entre migración y deploy.

test('legacy: sin usuarios, la clave de rol de env var sigue sirviendo', async () => {
  process.env.ADMIN_PASSWORD_HASH = hash('clave-vieja-admin');
  setFake(createFakeSupabase({ users: [] }));

  const res = await handler(loginEvent({ username: 'admin', password: 'clave-vieja-admin' }));
  const { status, body } = parseRes(res);
  assert.equal(status, 200);
  assert.equal(body.role, 'admin');
});

test('legacy: se apaga en cuanto existe un usuario activo', async () => {
  process.env.ADMIN_PASSWORD_HASH = hash('clave-vieja-admin');
  setFake(createFakeSupabase({ users: USERS }));

  const res = await handler(loginEvent({ username: 'admin', password: 'clave-vieja-admin' }));
  assert.equal(parseRes(res).status, 401);
});

test('legacy: clave de rol equivocada sigue siendo 401', async () => {
  process.env.ADMIN_PASSWORD_HASH = hash('clave-vieja-admin');
  setFake(createFakeSupabase({ users: [] }));

  const res = await handler(loginEvent({ username: 'admin', password: 'otra-cosa' }));
  assert.equal(parseRes(res).status, 401);
});

test('legacy: un username que no es un rol no abre nada', async () => {
  process.env.ADMIN_PASSWORD_HASH = hash('clave-vieja-admin');
  setFake(createFakeSupabase({ users: [] }));

  const res = await handler(loginEvent({ username: 'elias', password: 'clave-vieja-admin' }));
  assert.equal(parseRes(res).status, 401);
});

// El fake de Supabase trata una tabla ausente como vacía, así que la
// detección de "migración 0048 sin aplicar" se prueba directo contra
// las formas de error que devuelve PostgREST.
test('isMissingTable reconoce los errores de tabla inexistente', () => {
  const { isMissingTable } = require('../netlify/functions/_lib/users');

  assert.equal(isMissingTable({ code: '42P01', message: 'relation "users" does not exist' }), true);
  assert.equal(isMissingTable({ code: 'PGRST205', message: "Could not find the table 'public.users'" }), true);
  assert.equal(isMissingTable({ code: 'PGRST116', message: 'no rows returned' }), false);
  assert.equal(isMissingTable({ code: '23505', message: 'duplicate key value' }), false);
  assert.equal(isMissingTable(null), false);
});
