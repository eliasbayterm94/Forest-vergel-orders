import { api, ApiError } from './api.js';

let _session = null;

export function getSession() { return _session; }

export async function loadSession() {
  try {
    const me = await api.me();
    _session = me;
    return me;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { _session = null; return null; }
    throw e;
  }
}

export async function login(role, password) {
  const res = await api.login(role, password);
  _session = res;
  return res;
}

export async function logout() {
  try { await api.logout(); } catch {}
  _session = null;
}
