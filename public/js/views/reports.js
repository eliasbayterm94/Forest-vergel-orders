// Monthly reporting view — fully client-side aggregation off the
// existing /api/orders-list, /api/lots-list, /api/shipments-list
// endpoints. Tables are stacked vertically on mobile.

import { el } from '../ui/el.js';
import { fmtKg, fmtDate, statusLabel } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';

const MONTHS_BACK = 6;

export async function reportsView() {
  const [ordersRes, lotsRes, shipsRes] = await Promise.all([
    api.ordersList({}),
    api.lotsList({}),
    api.shipmentsList(),
  ]);
  const orders    = ordersRes.orders || [];
  const lots      = lotsRes.lots || [];
  const shipments = shipsRes.shipments || [];

  // Build the rolling list of YYYY-MM keys (newest first).
  const today = new Date(ordersRes.today + 'T12:00:00Z');
  const months = [];
  for (let i = 0; i < MONTHS_BACK; i++) {
    const d = new Date(today);
    d.setUTCMonth(d.getUTCMonth() - i);
    months.push(d.toISOString().slice(0, 7));
  }
  // months[0] = current month, months[MONTHS_BACK-1] = oldest

  // ── 1) Resumen por mes — pedidos creados / aceptados / completados / cancelados ─
  const monthSummary = months.map((mes) => {
    const inMonth = (s) => (s || '').slice(0, 7) === mes;
    const created   = orders.filter((o) => inMonth(o.created_at));
    const accepted  = orders.filter((o) => inMonth(o.accepted_at));
    const completed = orders.filter((o) => inMonth(o.completed_at));
    const cancelled = orders.filter((o) => inMonth(o.cancelled_at));
    const rejected  = orders.filter((o) => inMonth(o.rejected_at));
    const verdeSolicitado = sum(created,  (o) => o.kg_green_required);
    const verdeAceptado   = sum(accepted, (o) => o.kg_green_accepted);
    const verdeDespachado = sum(
      shipments.filter((s) => inMonth(s.shipment_date)),
      (s) => s.totals?.kg_green || 0,
    );
    return {
      mes, created: created.length, accepted: accepted.length,
      completed: completed.length, cancelled: cancelled.length, rejected: rejected.length,
      verdeSolicitado, verdeAceptado, verdeDespachado,
    };
  });

  // ── 2) Yield por mes — factor_rendimiento de lotes entregados ────────────
  const yieldByMonth = months.map((mes) => {
    const ls = lots.filter((l) =>
      l.status === 'Delivered'
      && (l.delivered_date || '').slice(0, 7) === mes
      && l.factor_rendimiento != null
    );
    if (ls.length === 0) {
      return { mes, count: 0, avg: null, min: null, max: null };
    }
    const factors = ls.map((l) => Number(l.factor_rendimiento));
    return {
      mes, count: ls.length,
      avg: factors.reduce((s, x) => s + x, 0) / factors.length,
      min: Math.min(...factors),
      max: Math.max(...factors),
    };
  });

  // ── 3) Tiempo de ciclo por mes (Pending → Completed, días) ───────────
  const cycleByMonth = months.map((mes) => {
    const completed = orders.filter((o) =>
      o.completed_at && (o.completed_at || '').slice(0, 7) === mes && o.created_at
    );
    if (completed.length === 0) {
      return { mes, count: 0, avgDays: null, minDays: null, maxDays: null };
    }
    const dayDiffs = completed.map((o) => {
      const a = new Date(o.created_at);
      const b = new Date(o.completed_at);
      return (b - a) / (1000 * 60 * 60 * 24);
    });
    return {
      mes, count: completed.length,
      avgDays: dayDiffs.reduce((s, x) => s + x, 0) / dayDiffs.length,
      minDays: Math.min(...dayDiffs),
      maxDays: Math.max(...dayDiffs),
    };
  });

  // ── 4) Por cliente (top 10 por verde aceptado, todo el periodo) ──────
  const byClient = groupBy(
    orders.filter((o) => o.client_name),
    (o) => o.client_name,
    (group) => ({
      pedidos: group.length,
      verdeSolicitado: sum(group, (o) => o.kg_green_required),
      verdeAceptado:   sum(group, (o) => o.kg_green_accepted),
      abiertos: group.filter((o) => ['Pending','Accepted','PartiallyAccepted','InProduction'].includes(o.status)).length,
      completados: group.filter((o) => o.status === 'Completed').length,
    }),
  )
    .sort((a, b) => Number(b[1].verdeAceptado || 0) - Number(a[1].verdeAceptado || 0))
    .slice(0, 10);

  // ── 5) Por región (multi-region orders count once per region) ────────
  const regionAgg = new Map();
  for (const o of orders) {
    if (!o.regions || o.regions.length === 0) continue;
    for (const r of o.regions) {
      if (!regionAgg.has(r)) regionAgg.set(r, { pedidos: 0, verdeSolicitado: 0, verdeAceptado: 0 });
      const b = regionAgg.get(r);
      b.pedidos += 1;
      b.verdeSolicitado += Number(o.kg_green_required || 0);
      b.verdeAceptado   += Number(o.kg_green_accepted || 0);
    }
  }
  const byRegion = [...regionAgg.entries()].sort((a, b) => b[1].verdeAceptado - a[1].verdeAceptado);

  // ── 6) Por tipo (Spot / Contract / FOB) ──────────────────────────────
  const byOrderType = groupBy(
    orders.filter((o) => o.order_type),
    (o) => o.order_type,
    (group) => ({
      pedidos: group.length,
      verdeSolicitado: sum(group, (o) => o.kg_green_required),
      verdeAceptado:   sum(group, (o) => o.kg_green_accepted),
    }),
  );

  return chrome(el('div', {}, [
    pageTitle('Reportes', `Últimos ${MONTHS_BACK} meses · ${orders.length} pedidos · ${lots.length} lotes · ${shipments.length} despachos`),

    section('Resumen mensual',
      tableEl(
        ['Mes', 'Creados', 'Aceptados', 'Completados', 'Cancelados', 'Rechazados', 'Verde solicitado', 'Verde aceptado', 'Verde despachado'],
        monthSummary.map((r) => [
          r.mes,
          String(r.created),
          String(r.accepted),
          String(r.completed),
          String(r.cancelled),
          String(r.rejected),
          fmtKg(r.verdeSolicitado),
          fmtKg(r.verdeAceptado),
          fmtKg(r.verdeDespachado),
        ]),
        // Total row
        [
          'TOTAL',
          String(sum(monthSummary, (r) => r.created)),
          String(sum(monthSummary, (r) => r.accepted)),
          String(sum(monthSummary, (r) => r.completed)),
          String(sum(monthSummary, (r) => r.cancelled)),
          String(sum(monthSummary, (r) => r.rejected)),
          fmtKg(sum(monthSummary, (r) => r.verdeSolicitado)),
          fmtKg(sum(monthSummary, (r) => r.verdeAceptado)),
          fmtKg(sum(monthSummary, (r) => r.verdeDespachado)),
        ],
      ),
    ),

    section('Yield por mes (factor de rendimiento)',
      tableEl(
        ['Mes', 'Lotes entregados', 'Factor promedio', 'Mínimo', 'Máximo'],
        yieldByMonth.map((r) => [
          r.mes,
          String(r.count),
          r.avg != null ? r.avg.toFixed(2) : '—',
          r.min != null ? r.min.toFixed(2) : '—',
          r.max != null ? r.max.toFixed(2) : '—',
        ]),
        null,
      ),
    ),

    section('Tiempo de ciclo · pedido → completado',
      tableEl(
        ['Mes', 'Pedidos completados', 'Días promedio', 'Mínimo', 'Máximo'],
        cycleByMonth.map((r) => [
          r.mes,
          String(r.count),
          r.avgDays != null ? r.avgDays.toFixed(1) : '—',
          r.minDays != null ? r.minDays.toFixed(1) : '—',
          r.maxDays != null ? r.maxDays.toFixed(1) : '—',
        ]),
        null,
      ),
    ),

    section('Top 10 clientes (por verde aceptado)',
      byClient.length === 0
        ? emptyText('Sin pedidos con cliente registrado.')
        : tableEl(
            ['Cliente', 'Pedidos', 'Abiertos', 'Completados', 'Verde solicitado', 'Verde aceptado'],
            byClient.map(([client, b]) => [
              client,
              String(b.pedidos),
              String(b.abiertos),
              String(b.completados),
              fmtKg(b.verdeSolicitado),
              fmtKg(b.verdeAceptado),
            ]),
            null,
          ),
    ),

    section('Por región',
      byRegion.length === 0
        ? emptyText('Sin pedidos con región registrada.')
        : tableEl(
            ['Región', 'Pedidos', 'Verde solicitado', 'Verde aceptado'],
            byRegion.map(([region, b]) => [
              region,
              String(b.pedidos),
              fmtKg(b.verdeSolicitado),
              fmtKg(b.verdeAceptado),
            ]),
            null,
          ),
    ),

    section('Por tipo de pedido',
      byOrderType.length === 0
        ? emptyText('Sin pedidos con tipo registrado.')
        : tableEl(
            ['Tipo', 'Pedidos', 'Verde solicitado', 'Verde aceptado'],
            byOrderType.map(([type, b]) => [
              type,
              String(b.pedidos),
              fmtKg(b.verdeSolicitado),
              fmtKg(b.verdeAceptado),
            ]),
            null,
          ),
    ),
  ]));
}

// ─── Helpers ────────────────────────────────────────────────────────
function sum(arr, getter) {
  return arr.reduce((s, x) => s + Number(getter(x) || 0), 0);
}

function groupBy(arr, keyFn, aggregator) {
  const map = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (k == null) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return [...map.entries()].map(([k, group]) => [k, aggregator(group)]);
}

function section(title, child) {
  return el('section', { class: 'mb-6' }, [
    el('h3', { class: 'eyebrow mb-2', text: title }),
    el('div', { class: 'ctrm-card' }, [child]),
  ]);
}

function emptyText(t) {
  return el('p', { class: 'text-[12px] text-ink-300 italic px-4 py-3', text: t });
}

function tableEl(headers, rows, totalsRow) {
  const wrap = el('div', { class: 'overflow-x-auto' });
  const t = el('table', { class: 'w-full text-[12px]' }, [
    el('thead', {}, [
      el('tr', {}, headers.map((h, i) =>
        el('th', { class: i === 0 ? '' : 'text-right' }, [h]),
      )),
    ]),
    el('tbody', {}, rows.map((r) =>
      el('tr', {}, r.map((cell, i) =>
        el('td', { class: i === 0 ? 'font-mono text-navy font-semibold' : 'text-right font-mono' }, [String(cell)]),
      )),
    )),
    totalsRow ? el('tfoot', {}, [
      el('tr', { class: 'bg-cream' }, totalsRow.map((cell, i) =>
        el('td', { class: i === 0 ? 'font-display font-bold uppercase tracking-loose text-navy' : 'text-right font-mono font-bold text-navy' }, [String(cell)]),
      )),
    ]) : null,
  ]);
  wrap.append(t);
  return wrap;
}
