#!/usr/bin/env node
'use strict';

// Valida que todos los .js bajo public/js parsean como ES module.
// `node -c` solo verifica sintaxis CommonJS y no atrapa errores que
// el browser SI ve cuando carga el modulo (e.g. la llave extra que
// dejo a la app en blanco en commit ebefc4c). Este check toma cada
// archivo, lo escribe como .mjs temporal y corre `node -c` sobre el.
//
// Falla con exit 1 si encuentra cualquier error de parse, listando
// los archivos rotos.

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'public', 'js');

function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (st.isFile() && p.endsWith('.js')) acc.push(p);
  }
  return acc;
}

const files = walk(JS_DIR);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esm-check-'));
const failures = [];

for (const file of files) {
  const tmp = path.join(tmpDir, path.basename(file).replace(/\.js$/, '.mjs'));
  fs.copyFileSync(file, tmp);
  try {
    execSync(`node -c "${tmp}"`, { stdio: 'pipe' });
  } catch (e) {
    const stderr = (e.stderr || '').toString().trim();
    failures.push({ file: path.relative(ROOT, file), error: stderr.split('\n').slice(0, 5).join('\n') });
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

try { fs.rmdirSync(tmpDir); } catch {}

if (failures.length === 0) {
  console.log(`ESM check: ${files.length} files OK`);
  process.exit(0);
}

console.error(`ESM check FAILED · ${failures.length} of ${files.length} files`);
for (const f of failures) {
  console.error(`\n  ${f.file}`);
  console.error('    ' + f.error.replace(/\n/g, '\n    '));
}
process.exit(1);
