'use strict';

/**
 * Stub in-memory del cliente Supabase, cubriendo las cadenas del
 * query-builder que usan las Netlify Functions bajo test:
 *
 *   .from(t).select(cols[, {count, head}]).eq().in().is().neq()
 *           .order().limit().single()/.maybeSingle()
 *   .from(t).insert(rows)[.select()[.single()]]
 *   .from(t).update(patch).eq(...)[.select()[.single()/.maybeSingle()]]
 *   .from(t).delete().eq(...).in(...)
 *
 * Los "embeds" de PostgREST (p.ej. select('a, rel(b)')) NO se
 * resuelven: las filas del fixture deben venir ya con la forma
 * embebida (rel: {...} o rel: [...]). Los filtros con ruta punteada
 * ('production_lots.status') sí se resuelven contra esa forma.
 *
 * Extras para tests:
 *   fake._db                       — tablas en vivo para asserts
 *   fake.failOnInsert(t, message)  — simula un error de trigger en
 *                                    el próximo insert a esa tabla
 *   fake.failOnUpdate(t, message)  — idem para update
 */

const crypto = require('node:crypto');

function createFakeSupabase(tables = {}) {
  const db = {};
  for (const [name, rows] of Object.entries(tables)) {
    db[name] = rows.map((r) => ({ ...r }));
  }
  const insertFailures = new Map();   // table → message (one-shot)
  const updateFailures = new Map();

  function getVal(row, key) {
    if (!key.includes('.')) return row[key];
    return key.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), row);
  }

  class Builder {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.op = 'select';
      this.payload = null;
      this._single = null;      // 'single' | 'maybe' | null
      this._count = null;
      this._head = false;
      this._order = [];
      this._limit = null;
      this._selectAfter = false;
    }

    select(_cols, opts = {}) {
      this._selectAfter = true;
      if (opts.count) this._count = opts.count;
      if (opts.head) this._head = true;
      return this;
    }
    insert(rows) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
    update(patch) { this.op = 'update'; this.payload = patch; return this; }
    delete() { this.op = 'delete'; return this; }

    eq(k, v)  { this.filters.push((r) => String(getVal(r, k)) === String(v)); return this; }
    neq(k, v) { this.filters.push((r) => String(getVal(r, k)) !== String(v)); return this; }
    in(k, arr) { const set = new Set((arr || []).map(String)); this.filters.push((r) => set.has(String(getVal(r, k)))); return this; }
    is(k, v)  { this.filters.push((r) => getVal(r, k) == v); return this; }   // == para null/undefined

    order(k, opts = {}) { this._order.push({ k, asc: opts.ascending !== false }); return this; }
    limit(n) { this._limit = n; return this; }
    single() { this._single = 'single'; return this; }
    maybeSingle() { this._single = 'maybe'; return this; }

    _rows() {
      let rows = (db[this.table] || []).filter((r) => this.filters.every((f) => f(r)));
      for (const { k, asc } of this._order) {
        rows = rows.slice().sort((a, b) => {
          const av = getVal(a, k); const bv = getVal(b, k);
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          if (av < bv) return asc ? -1 : 1;
          if (av > bv) return asc ? 1 : -1;
          return 0;
        });
      }
      if (this._limit != null) rows = rows.slice(0, this._limit);
      return rows;
    }

    _exec() {
      if (this.op === 'select') {
        const rows = this._rows();
        if (this._head) return { data: null, error: null, count: rows.length };
        if (this._single) {
          const row = rows[0] ?? null;
          if (this._single === 'single' && !row) {
            return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
          }
          return { data: row, error: null };
        }
        return { data: rows, error: null, count: this._count ? rows.length : undefined };
      }
      if (this.op === 'insert') {
        if (insertFailures.has(this.table)) {
          const message = insertFailures.get(this.table);
          insertFailures.delete(this.table);
          return { data: null, error: { message } };
        }
        const inserted = this.payload.map((r) => ({ id: r.id || crypto.randomUUID(), ...r }));
        db[this.table] = (db[this.table] || []).concat(inserted);
        if (!this._selectAfter) return { data: null, error: null };
        return { data: this._single ? inserted[0] : inserted, error: null };
      }
      if (this.op === 'update') {
        if (updateFailures.has(this.table)) {
          const message = updateFailures.get(this.table);
          updateFailures.delete(this.table);
          return { data: null, error: { message } };
        }
        const rows = this._rows();
        rows.forEach((r) => Object.assign(r, this.payload));
        if (!this._selectAfter) return { data: null, error: null };
        if (this._single) {
          const row = rows[0] ?? null;
          if (this._single === 'single' && !row) {
            return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
          }
          return { data: row, error: null };
        }
        return { data: rows, error: null };
      }
      if (this.op === 'delete') {
        const match = new Set(this._rows());
        db[this.table] = (db[this.table] || []).filter((r) => !match.has(r));
        return { data: null, error: null };
      }
      return { data: null, error: { message: `Unsupported op ${this.op}` } };
    }

    then(resolve, reject) { return Promise.resolve(this._exec()).then(resolve, reject); }
  }

  return {
    from: (t) => new Builder(t),
    _db: db,
    failOnInsert: (t, message) => insertFailures.set(t, message),
    failOnUpdate: (t, message) => updateFailures.set(t, message),
  };
}

module.exports = { createFakeSupabase };
