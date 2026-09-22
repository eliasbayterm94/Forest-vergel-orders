// CRUD de usuarios (admin): creación, reseteo de contraseña, cambio
// de rol y la guarda que impide dejar el sistema sin admin activo.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createFakeSupabase } = require('./helpers/fake-supabase');
const { loadHandler, setFake, postEvent, parseRes } = require('./helpers/fn-harness');

const hash = (pw) => bcrypt.hashSync(pw, 4);

function seed() {
  return [
    { id: 'u1', username: 'elias', full_name: 'Elias Bayter', password_hash: hash('secreta123'), role: 'admin', active: true },
    { id: 'u2', username: 'juan',  full_name: 'Juan Pérez',   password_hash: hash('fincapass1'), role: 'finca', active: true },
  ];
}

const createH = loadHandler('users-create', createFakeSupabase({ users: seed() }));
const updateH = loadHandler('users-update');
const listH   = loadHandler('users-list');

const asAdmin = (body) => postEvent(body, { role: 'admin' });

// ── users-create ──────────────────────────────────────────────────

test('crear usuario: 201 y nunca devuelve el hash', async () => {
  const fake = createFakeSupabase({ users: seed() });
  setFake(fake);

  const res = await createH(asAdmin({
    username: 'maria', password: 'claveSegura9', role: 'forest', full_name: 'María Gómez',
  }));
  const { status, body } = parseRes(res);

  assert.equal(status, 201);
  assert.equal(body.user.username, 'maria');
  assert.equal(body.user.role, 'forest');
  assert.equal(body.user.active, true);
  assert.equal(body.user.password_hash, undefined);

  // La fila guardada tiene un hash válido de la clave entregada.
  const row = fake._db.users.find((u) => u.username === 'maria');
  assert.ok(bcrypt.compareSync('claveSegura9', row.password_hash));
});

test('crear usuario: normaliza a minúsculas', async () => {
  const fake = createFakeSupabase({ users: seed() });
  setFake(fake);
  const res = await createH(asAdmin({ username: '  MaRiA  ', password: 'claveSegura9', role: 'finca' }));
  assert.equal(parseRes(res).body.user.username, 'maria');
});

test('crear usuario: duplicado devuelve 409, no pisa la contraseña', async () => {
  const fake = createFakeSupabase({ users: seed() });
  setFake(fake);

  const res = await createH(asAdmin({ username: 'elias', password: 'otraClave12', role: 'admin' }));
  const { status, body } = parseRes(res);

  assert.equal(status, 409);
  assert.equal(body.code, 'USERNAME_TAKEN');
  // La clave original sigue sirviendo.
  const row = fake._db.users.find((u) => u.username === 'elias');
  assert.ok(bcrypt.compareSync('secreta123', row.password_hash));
});

test('crear usuario: contraseña corta y rol inválido → 400', async () => {
  setFake(createFakeSupabase({ users: seed() }));

  const short = parseRes(await createH(asAdmin({ username: 'pepe', password: 'corta', role: 'finca' })));
  assert.equal(short.status, 400);
  assert.equal(short.body.code, 'PASSWORD_TOO_SHORT');

  const role = parseRes(await createH(asAdmin({ username: 'pepe', password: 'claveSegura9', role: 'jefe' })));
  assert.equal(role.status, 400);
  assert.equal(role.body.code, 'ROLE_INVALID');
});

test('crear usuario: username con caracteres inválidos → 400', async () => {
  setFake(createFakeSupabase({ users: seed() }));
  const res = parseRes(await createH(asAdmin({ username: 'ju an@x', password: 'claveSegura9', role: 'finca' })));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'USERNAME_INVALID');
});

test('crear usuario: un rol no-admin recibe 403', async () => {
  setFake(createFakeSupabase({ users: seed() }));
  const res = await createH(postEvent(
    { username: 'pepe', password: 'claveSegura9', role: 'admin' }, { role: 'finca' }));
  assert.equal(parseRes(res).status, 403);
});

// ── users-update ──────────────────────────────────────────────────

test('resetear contraseña: la nueva sirve y la vieja deja de servir', async () => {
  const fake = createFakeSupabase({ users: seed() });
  setFake(fake);

  const res = await updateH(asAdmin({ id: 'u2', fields: { password: 'nuevaClave99' } }));
  const { status, body } = parseRes(res);

  assert.equal(status, 200);
  assert.equal(body.password_changed, true);
  assert.equal(body.user.password_hash, undefined);

  const row = fake._db.users.find((u) => u.id === 'u2');
  assert.ok(bcrypt.compareSync('nuevaClave99', row.password_hash));
  assert.equal(bcrypt.compareSync('fincapass1', row.password_hash), false);
});

test('resetear contraseña: rechaza una clave corta sin tocar la fila', async () => {
  const fake = createFakeSupabase({ users: seed() });
  setFake(fake);

  const res = parseRes(await updateH(asAdmin({ id: 'u2', fields: { password: 'abc' } })));
  assert.equal(res.status, 400);

  const row = fake._db.users.find((u) => u.id === 'u2');
  assert.ok(bcrypt.compareSync('fincapass1', row.password_hash));
});

test('desactivar al último admin activo → 409 LAST_ADMIN', async () => {
  const fake = createFakeSupabase({ users: seed() });
  setFake(fake);

  const res = parseRes(await updateH(asAdmin({ id: 'u1', fields: { active: false } })));
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'LAST_ADMIN');
  assert.equal(fake._db.users.find((u) => u.id === 'u1').active, true);
});

test('degradar al último admin activo → 409 LAST_ADMIN', async () => {
  const fake = createFakeSupabase({ users: seed() });
  setFake(fake);

  const res = parseRes(await updateH(asAdmin({ id: 'u1', fields: { role: 'finca' } })));
  assert.equal(res.status, 409);
  assert.equal(fake._db.users.find((u) => u.id === 'u1').role, 'admin');
});

test('con dos admins activos, desactivar uno sí se permite', async () => {
  const users = seed().concat({
    id: 'u3', username: 'sofia', full_name: null, password_hash: hash('otraClave12'), role: 'admin', active: true,
  });
  const fake = createFakeSupabase({ users });
  setFake(fake);

  const res = parseRes(await updateH(asAdmin({ id: 'u1', fields: { active: false } })));
  assert.equal(res.status, 200);
  assert.equal(res.body.user.active, false);
});

test('resetear la clave del último admin sí se permite (no lo deja sin acceso)', async () => {
  const fake = createFakeSupabase({ users: seed() });
  setFake(fake);

  const res = parseRes(await updateH(asAdmin({ id: 'u1', fields: { password: 'nuevaClave99' } })));
  assert.equal(res.status, 200);
});

test('campos no permitidos se ignoran; sin campos válidos → 400', async () => {
  const fake = createFakeSupabase({ users: seed() });
  setFake(fake);

  const res = parseRes(await updateH(asAdmin({ id: 'u2', fields: { password_hash: 'inyectado', username: 'otro' } })));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'NO_FIELDS');

  const row = fake._db.users.find((u) => u.id === 'u2');
  assert.notEqual(row.password_hash, 'inyectado');
  assert.equal(row.username, 'juan');
});

test('usuario inexistente → 404', async () => {
  setFake(createFakeSupabase({ users: seed() }));
  const res = parseRes(await updateH(asAdmin({ id: 'nope', fields: { active: false } })));
  assert.equal(res.status, 404);
});

// ── users-list ────────────────────────────────────────────────────

const getEvent = (role) => ({
  httpMethod: 'GET',
  headers: postEvent(null, { role }).headers,
  queryStringParameters: {},
});

test('listar usuarios no expone hashes', async () => {
  setFake(createFakeSupabase({ users: seed() }));
  const res = parseRes(await listH(getEvent('admin')));

  assert.equal(res.status, 200);
  assert.equal(res.body.users.length, 2);
  for (const u of res.body.users) assert.equal(u.password_hash, undefined);
});

test('listar usuarios: un rol no-admin recibe 403', async () => {
  setFake(createFakeSupabase({ users: seed() }));
  assert.equal(parseRes(await listH(getEvent('finca'))).status, 403);
});
