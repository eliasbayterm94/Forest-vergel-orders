'use strict';

/**
 * Harness para testear Netlify Functions completas (con requireAuth
 * y getSupabase) sin red ni BD:
 *
 *   const { loadHandler, postEvent, parseRes } = require('./helpers/fn-harness');
 *   const fake = createFakeSupabase({ production_lots: [...] });
 *   const handler = loadHandler('production-lots-adjust-dried', fake);
 *   const res = await handler(postEvent({ lot_id, ... }), {});
 *   const body = parseRes(res);
 *
 * Cómo funciona: setea JWT_SECRET, parchea getSupabase en el módulo
 * _lib/supabase ANTES de requerir el endpoint (los endpoints
 * desestructuran en el require, así que el orden importa), y firma
 * una cookie válida con el rol pedido.
 *
 * IMPORTANTE: cada archivo de test corre en su propio proceso
 * (node --test), así que el require-cache no contamina entre archivos.
 * Dentro de un mismo archivo, loadHandler() solo puede parchear el
 * fake ANTES del primer require de ese endpoint; para cambiar el
 * fixture entre tests usa setFake().
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-0123456789abcdef0123456789abcdef';

const path = require('node:path');
const FN_DIR = path.join(__dirname, '..', '..', 'netlify', 'functions');

const supaModule = require(path.join(FN_DIR, '_lib', 'supabase'));
const { sign, COOKIE_NAME } = require(path.join(FN_DIR, '_lib', 'auth'));

let _fake = null;
supaModule.getSupabase = () => {
  if (!_fake) throw new Error('fn-harness: llama setFake()/loadHandler() antes de invocar el handler');
  return _fake;
};
// Divisores por proceso sin tocar BD (mismo default de migration 0006)
supaModule.getDriedDivisorsByProcess = async () => ({ Natural: 3.40, Honey: 1.50, Lavado: 1.34 });

function setFake(fake) { _fake = fake; }

function loadHandler(fnName, fake) {
  if (fake) setFake(fake);
  const mod = require(path.join(FN_DIR, fnName));
  return mod.handler;
}

function postEvent(body, { role = 'finca', method = 'POST' } = {}) {
  return {
    httpMethod: method,
    headers: { cookie: `${COOKIE_NAME}=${sign({ role })}` },
    body: body != null ? JSON.stringify(body) : null,
    queryStringParameters: {},
  };
}

function parseRes(res) {
  let body = null;
  try { body = JSON.parse(res.body); } catch { body = res.body; }
  return { status: res.statusCode, body };
}

module.exports = { loadHandler, setFake, postEvent, parseRes };
