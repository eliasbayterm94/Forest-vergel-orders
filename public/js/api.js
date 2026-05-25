// Tiny fetch wrapper for /api/* endpoints. Always sends cookies.
// Throws ApiError({status, code, message}) on non-2xx.

export class ApiError extends Error {
  constructor({ status, code, message, detail }) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function request(method, path, { body, query } = {}) {
  let url = path.startsWith('/') ? path : `/api/${path}`;
  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v == null || v === '') continue;
      qs.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('application/json')) {
    try { payload = await res.json(); } catch { payload = null; }
  }
  if (!res.ok) {
    const err = new ApiError({
      status: res.status,
      code:    payload?.code,
      message: payload?.error || res.statusText,
      detail:  payload?.detail || payload,
    });
    if (res.status === 401) window.dispatchEvent(new CustomEvent('app:unauthorized'));
    throw err;
  }
  return payload;
}

export const api = {
  get:  (p, query)        => request('GET',  `/api/${p}`, { query }),
  post: (p, body, query)  => request('POST', `/api/${p}`, { body, query }),

  // Sugar
  me:                     () => request('GET',  '/api/me'),
  login:  (role, password)=> request('POST', '/api/login',  { body: { role, password } }),
  logout: ()              => request('POST', '/api/logout'),

  varieties:    () => request('GET',  '/api/varieties-list'),
  varietyAdd:   (name) => request('POST', '/api/varieties-create', { body: { name } }),
  infusions:    () => request('GET',  '/api/infusions-list'),
  infusionAdd:  (name) => request('POST', '/api/infusions-create', { body: { name } }),

  references:    () => request('GET',  '/api/references-list'),
  referenceSave: (payload) => request('POST', '/api/references-create', { body: payload }),

  ordersList:    (query)  => request('GET',  '/api/demand-orders-list', { query }),
  orderCreate:   (payload) => request('POST', '/api/demand-orders-create', { body: payload }),
  orderCreateBulk: (payload) => request('POST', '/api/demand-orders-create-bulk', { body: payload }),
  orderUpdate:   (payload) => request('POST', '/api/demand-orders-update', { body: payload }),
  orderCancel:   (payload) => request('POST', '/api/demand-orders-cancel', { body: payload }),
  orderAccept:   (payload) => request('POST', '/api/demand-orders-accept', { body: payload }),
  orderReject:   (payload) => request('POST', '/api/demand-orders-reject', { body: payload }),
  orderUpdatePo: (payload) => request('POST', '/api/demand-orders-update-po', { body: payload }),

  lotsList:        (query) => request('GET',  '/api/production-lots-list', { query }),
  lotCreate:       (payload) => request('POST', '/api/production-lots-create', { body: payload }),
  lotCreateBulk:   (payload) => request('POST', '/api/production-lots-create-bulk', { body: payload }),
  lotUpdate:       (payload) => request('POST', '/api/production-lots-update', { body: payload }),
  lotUpdateStatus: (payload) => request('POST', '/api/production-lots-update-status', { body: payload }),
  lotDelete:       (payload) => request('POST', '/api/production-lots-delete', { body: payload }),

  lotRestingCycleUpdate: (payload) => request('POST', '/api/lot-resting-cycles-update', { body: payload }),

  lotPartialCreate: (payload) => request('POST', '/api/lot-partials-create', { body: payload }),
  lotPartialDelete: (payload) => request('POST', '/api/lot-partials-delete', { body: payload }),
  lotPartialReject: (payload) => request('POST', '/api/lot-partials-reject', { body: payload }),

  assignmentsCreate: (payload) => request('POST', '/api/lot-assignments-create', { body: payload }),
  assignmentsUpdate: (payload) => request('POST', '/api/lot-assignments-update', { body: payload }),
  assignmentsDelete: (payload) => request('POST', '/api/lot-assignments-delete', { body: payload }),

  capacity: (payload) => request('POST', '/api/capacity-calculate', { body: payload }),
  processLeadTimes: () => request('GET', '/api/process-lead-times-list'),

  weeklyPlanGet:     (week) => request('GET',  '/api/weekly-plan-get', { query: { week } }),
  weeklyPlanCompute: (payload) => request('POST', '/api/weekly-plan-compute', { body: payload }),
  lotBlendCreate:    (payload) => request('POST', '/api/lot-blend-create', { body: payload }),
  lotSplit:          (payload) => request('POST', '/api/lot-split',        { body: payload }),
  search: (q, limit) => request('GET', '/api/search', { query: { q, limit } }),
  auditLog: (query) => request('GET', '/api/audit-log-list', { query }),
  badges: () => request('GET', '/api/badges'),
  emailLog: (query) => request('GET', '/api/email-log-list', { query }),

  productionConfigGet:    ()        => request('GET',  '/api/production-config-get'),
  productionConfigUpdate: (payload) => request('POST', '/api/production-config-update', { body: payload }),
  processLeadTimeUpdate:  (payload) => request('POST', '/api/process-lead-times-update', { body: payload }),

  shipmentsList:   ()        => request('GET',  '/api/shipments-list'),
  shipmentsCreate: (payload) => request('POST', '/api/shipments-create', { body: payload }),
  shipmentsCancel: (payload) => request('POST', '/api/shipments-cancel', { body: payload }),

  digestTrigger: () => request('POST', '/api/weekly-digest-trigger'),
};
