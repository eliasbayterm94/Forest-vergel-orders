'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { actorLabel } = require('../netlify/functions/_lib/actor');

test('rol + operario', () => {
  assert.equal(actorLabel({ role: 'finca' }, { operator_name: 'Juan Pérez' }), 'finca (Juan Pérez)');
});

test('solo rol si no hay operario', () => {
  assert.equal(actorLabel({ role: 'finca' }, {}), 'finca');
  assert.equal(actorLabel({ role: 'forest' }, { operator_name: '' }), 'forest');
  assert.equal(actorLabel({ role: 'admin' }, { operator_name: '   ' }), 'admin');
});

test('sin sesión → unknown', () => {
  assert.equal(actorLabel(null, {}), 'unknown');
  assert.equal(actorLabel(undefined, null), 'unknown');
});

test('operator_name no-string se ignora', () => {
  assert.equal(actorLabel({ role: 'finca' }, { operator_name: 42 }), 'finca');
  assert.equal(actorLabel({ role: 'finca' }, { operator_name: { hack: true } }), 'finca');
});

test('nombre largo se trunca a 60', () => {
  const long = 'x'.repeat(100);
  const out = actorLabel({ role: 'finca' }, { operator_name: long });
  assert.equal(out, `finca (${'x'.repeat(60)})`);
});
