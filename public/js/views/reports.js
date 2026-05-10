// Reportes — agregaciones cliente sobre orders, lots, shipments con
// rango configurable (3m / 6m / 12m / año actual), barras visuales por
// mes y export CSV por sección.

import { el, clear } from '../ui/el.js';
import { fmtKg, fmtDate } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { toast } from '../ui/toast.js';

const RANGES = [
  { key: '3m',  label: '3 meses',  months: 3  },
  { key: '6m',  label: '6 meses',  months: 6  },
  { key: '12m', label: '12 meses', months: 12 },
  { key: 'ytd', label: 'Año actual', months: null },
];
const DEFAULT_RANGE = '6m';

export async function reportsView() {
  const [ordersRes, lotsRes, shipsRes] = await Promise.all([
    api.ordersList({}),
    api.lotsList({}),
    api.shipmentsList(),
  ]);
  const orders    = ordersRes.orders || [];
  const lots      = lotsRes.lots || [];
  const shipments = shipsRes.shipments || [];
  const todayStr  = ordersRes.today;

  let activeRange = DEFAULT_RANGE;

  const sectionsWrap = el('div', {});
  const rangeBar = rangeSelector(() => activeRange, (k) => {
    activeRange = k;
    redraw();
  });

  function redraw() {
    clear(sectionsWrap);
    const months = monthKeysForRange(todayStr, activeRange);
    const data = computeAggregations({ orders, lots, shipments, months });
    sectionsWrap.append(...buildSections(data, months));
    // Refresh the active state of the range buttons.
    rangeBar.refresh();
  }
  redraw();

  return chrome(el('div', {}, [
    pageTitle('Reportes',
      `${orders.length} pedidos · ${lots.length} lotes · ${shipments.length} despachos`),
    rangeBar.el,
    sectionsWrap,
  ]));
}

// ─── Range selector ─────────────────────────────────────────────────
function rangeSelector(getActive, onChange) {
  const buttons = RANGES.map((r) => el('button', {
    type: 'button',
    class: 'ctrm-btn ctrm-btn-sm',
    onClick: () => onChange(r.key),
    'data-range': r.key,
  }, [r.label]));

  const wrap = el('div', { class: 'flex flex-wrap gap-2 mb-4' }, buttons);

  function refresh() {
    const active = getActive();
    for (const b of buttons) {
      const isActive = b.getAttribute('data-range') === active;
      b.className = isActive
        ? 'ctrm-btn ctrm-btn-primary ctrm-btn-sm'
        : 'ctrm-btn ctrm-btn-soft ctrm-btn-sm';
    }
  }
  refresh();

  return { el: wrap, refresh };
}

function monthKeysForRange(todayStr, rangeKey) {
  const today = new Date(todayStr + 'T12:00:00Z');
  const r = RANGES.find((x) => x.key === rangeKey) || RANGES[1];
  const months = [];
  if (r.key === 'ytd') {
    const year = today.getUTCFullYear();
    const startMonth = 0;
    const endMonth = today.getUTCMonth();
    for (let m = endMonth; m >= startMonth; m--) {
      const d = new Date(Date.UTC(year, m, 1));
      months.push(d.toISOString().slice(0, 7));
    }
  } else {
    for (let i = 0; i < r.months; i++) {
      const d = new Date(today);
      d.setUTCMonth(d.getUTCMonth() - i);
      months.push(d.toISOString().slice(0, 7));
    }
  }
  return months;
}

// ─── Aggregations ───────────────────────────────────────────────────
function computeAggregations({ orders, lots, shipments, months }) {
  const monthSet = new Set(months);
  const inMonths = (s) => monthSet.has((s || '').slice(0, 7));

  // 1) Resumen mensual
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
      mes,
      created:   created.length,
      accepted:  accepted.length,
      completed: completed.length,
      cancelled: cancelled.length,
      rejected:  rejected.length,
      verdeSolicitado, verdeAceptado, verdeDespachado,
    };
  });

  // 2) Yield por mes
  const yieldByMonth = months.map((mes) => {
    const ls = lots.filter((l) =>
      l.status === 'Delivered'
      && (l.delivered_date || '').slice(0, 7) === mes
      && l.factor_rendimiento != null
    );
    if (ls.length === 0) return { mes, count: 0, avg: null, min: null, max: null };
    const factors = ls.map((l) => Number(l.factor_rendimiento));
    return {
      mes, count: ls.length,
      avg: factors.reduce((s, x) => s + x, 0) / factors.length,
      min: Math.min(...factors), max: Math.max(...factors),
    };
  });

  // 3) Tiempo de ciclo
  const cycleByMonth = months.map((mes) => {
    const completed = orders.filter((o) =>
      o.completed_at && (o.completed_at || '').slice(0, 7) === mes && o.created_at);
    if (completed.length === 0) return { mes, count: 0, avgDays: null, minDays: null, maxDays: null };
    const dayDiffs = completed.map((o) =>
      (new Date(o.completed_at) - new Date(o.created_at)) / 86400000);
    return {
      mes, count: completed.length,
      avgDays: dayDiffs.reduce((s, x) => s + x, 0) / dayDiffs.length,
      minDays: Math.min(...dayDiffs), maxDays: Math.max(...dayDiffs),
    };
  });

  // 4) Cumplimiento de plazos: por mes, completados a tiempo vs tarde
  const onTimeByMonth = months.map((mes) => {
    const completedInMonth = orders.filter((o) =>
      o.completed_at && (o.completed_at || '').slice(0, 7) === mes && o.max_delivery_date);
    if (completedInMonth.length === 0) {
      return { mes, total: 0, onTime: 0, late: 0, pctOnTime: null, avgDaysLate: null };
    }
    const onTime = completedInMonth.filter((o) => {
      // A 'YYYY-MM-DD' string compares correctly lexicographically.
      const completedDay = (o.completed_at || '').slice(0, 10);
      return completedDay <= o.max_delivery_date;
    });
    const late = completedInMonth.filter((o) => {
      const completedDay = (o.completed_at || '').slice(0, 10);
      return completedDay > o.max_delivery_date;
    });
    const lateDays = late.map((o) => {
      const a = new Date(o.max_delivery_date + 'T12:00:00Z');
      const b = new Date((o.completed_at || '').slice(0, 10) + 'T12:00:00Z');
      return Math.max(0, (b - a) / 86400000);
    });
    const total = completedInMonth.length;
    return {
      mes,
      total,
      onTime: onTime.length,
      late: late.length,
      pctOnTime: (onTime.length / total) * 100,
      avgDaysLate: lateDays.length > 0 ? lateDays.reduce((s, x) => s + x, 0) / lateDays.length : null,
    };
  });

  // 5) Parciales rechazados (en el rango)
  const rejectedPartials = [];
  for (const lot of lots) {
    for (const p of lot.partials || []) {
      if (!p.rejected_at) continue;
      if (!inMonths(p.rejected_at)) continue;
      rejectedPartials.push({
        lot_id: lot.id,
        bache_code: lot.bache_code || lot.lot_code,
        reference_name: lot.reference_name,
        process_type: lot.process_type,
        parcial_letter: p.parcial_letter,
        kg_dried: Number(p.kg_dried || 0),
        kg_green_yield: Number(p.kg_green_yield || 0),
        rejected_at: p.rejected_at,
        reason: (p.rejection_reason || '').trim() || null,
      });
    }
  }
  const rejectedTotalsByReason = groupBy(
    rejectedPartials,
    (p) => p.reason || '(sin motivo)',
    (g) => ({
      count:    g.length,
      kg_green: sum(g, (p) => p.kg_green_yield),
      kg_dried: sum(g, (p) => p.kg_dried),
    }),
  ).sort((a, b) => b[1].kg_green - a[1].kg_green);
  const rejectedSummary = {
    count: rejectedPartials.length,
    kg_green: sum(rejectedPartials, (p) => p.kg_green_yield),
    kg_dried: sum(rejectedPartials, (p) => p.kg_dried),
    items: rejectedPartials,
    byReason: rejectedTotalsByReason,
  };

  // 6) Top 10 clientes (todo el periodo cargado)
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

  // 7) Por región
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

  // 8) Por tipo de pedido
  const byOrderType = groupBy(
    orders.filter((o) => o.order_type),
    (o) => o.order_type,
    (group) => ({
      pedidos: group.length,
      verdeSolicitado: sum(group, (o) => o.kg_green_required),
      verdeAceptado:   sum(group, (o) => o.kg_green_accepted),
    }),
  );

  return {
    monthSummary, yieldByMonth, cycleByMonth,
    onTimeByMonth, rejectedSummary,
    byClient, byRegion, byOrderType,
  };
}

// ─── Sections ───────────────────────────────────────────────────────
function buildSections(data, months) {
  const {
    monthSummary, yieldByMonth, cycleByMonth,
    onTimeByMonth, rejectedSummary,
    byClient, byRegion, byOrderType,
  } = data;

  // For mini-bars: scale by max created (most expressive base across columns).
  const maxRowTotal = Math.max(1, ...monthSummary.map((r) =>
    r.created + r.accepted + r.completed + r.cancelled + r.rejected));

  return [
    section('Resumen mensual', sectionTable({
      headers: ['Mes', 'Distribución', 'Creados', 'Aceptados', 'Completados', 'Cancelados', 'Rechazados',
                'Verde solicitado', 'Verde aceptado', 'Verde despachado'],
      rows: monthSummary.map((r) => [
        r.mes,
        miniStack(r, maxRowTotal),
        String(r.created), String(r.accepted), String(r.completed), String(r.cancelled), String(r.rejected),
        fmtKg(r.verdeSolicitado), fmtKg(r.verdeAceptado), fmtKg(r.verdeDespachado),
      ]),
      totals: [
        'TOTAL',
        '',
        String(sum(monthSummary, (r) => r.created)),
        String(sum(monthSummary, (r) => r.accepted)),
        String(sum(monthSummary, (r) => r.completed)),
        String(sum(monthSummary, (r) => r.cancelled)),
        String(sum(monthSummary, (r) => r.rejected)),
        fmtKg(sum(monthSummary, (r) => r.verdeSolicitado)),
        fmtKg(sum(monthSummary, (r) => r.verdeAceptado)),
        fmtKg(sum(monthSummary, (r) => r.verdeDespachado)),
      ],
      csv: () => csvFromTable(
        ['Mes','Creados','Aceptados','Completados','Cancelados','Rechazados',
         'Verde_solicitado_kg','Verde_aceptado_kg','Verde_despachado_kg'],
        monthSummary.map((r) => [r.mes, r.created, r.accepted, r.completed, r.cancelled, r.rejected,
          round2(r.verdeSolicitado), round2(r.verdeAceptado), round2(r.verdeDespachado)]),
        'resumen-mensual',
      ),
      legend: stackLegend(),
    })),

    section('Cumplimiento de plazos',
      sectionTable({
        headers: ['Mes', 'Completados', 'A tiempo', 'Tarde', '% a tiempo', 'Días tarde prom.'],
        rows: onTimeByMonth.map((r) => {
          const pctClass = r.pctOnTime == null
            ? 'text-ink-300'
            : r.pctOnTime >= 90 ? 'text-ok'
            : r.pctOnTime >= 70 ? 'text-warn' : 'text-crit';
          return [
            r.mes, String(r.total),
            String(r.onTime), String(r.late),
            { value: r.pctOnTime != null ? `${r.pctOnTime.toFixed(0)}%` : '—', class: pctClass + ' font-bold' },
            r.avgDaysLate != null ? r.avgDaysLate.toFixed(1) : '—',
          ];
        }),
        totals: null,
        csv: () => csvFromTable(
          ['Mes','Completados','A_tiempo','Tarde','Pct_a_tiempo','Dias_tarde_prom'],
          onTimeByMonth.map((r) => [
            r.mes, r.total, r.onTime, r.late,
            r.pctOnTime != null ? r.pctOnTime.toFixed(0) : '',
            r.avgDaysLate != null ? r.avgDaysLate.toFixed(1) : '',
          ]),
          'cumplimiento-plazos',
        ),
      }),
    ),

    section('Yield por mes (factor de rendimiento)', sectionTable({
      headers: ['Mes', 'Lotes entregados', 'Factor promedio', 'Mínimo', 'Máximo'],
      rows: yieldByMonth.map((r) => [
        r.mes, String(r.count),
        r.avg != null ? r.avg.toFixed(2) : '—',
        r.min != null ? r.min.toFixed(2) : '—',
        r.max != null ? r.max.toFixed(2) : '—',
      ]),
      totals: null,
      csv: () => csvFromTable(
        ['Mes','Lotes_entregados','Factor_promedio','Factor_min','Factor_max'],
        yieldByMonth.map((r) => [
          r.mes, r.count,
          r.avg != null ? r.avg.toFixed(2) : '',
          r.min != null ? r.min.toFixed(2) : '',
          r.max != null ? r.max.toFixed(2) : '',
        ]),
        'yield-por-mes',
      ),
    })),

    section('Tiempo de ciclo · pedido → completado', sectionTable({
      headers: ['Mes', 'Pedidos completados', 'Días promedio', 'Mínimo', 'Máximo'],
      rows: cycleByMonth.map((r) => [
        r.mes, String(r.count),
        r.avgDays != null ? r.avgDays.toFixed(1) : '—',
        r.minDays != null ? r.minDays.toFixed(1) : '—',
        r.maxDays != null ? r.maxDays.toFixed(1) : '—',
      ]),
      totals: null,
      csv: () => csvFromTable(
        ['Mes','Pedidos_completados','Dias_promedio','Dias_min','Dias_max'],
        cycleByMonth.map((r) => [
          r.mes, r.count,
          r.avgDays != null ? r.avgDays.toFixed(1) : '',
          r.minDays != null ? r.minDays.toFixed(1) : '',
          r.maxDays != null ? r.maxDays.toFixed(1) : '',
        ]),
        'tiempo-ciclo',
      ),
    })),

    section(`Parciales rechazados (en ${months.length === 1 ? 'el mes' : `${months.length} meses`})`,
      rejectedSection(rejectedSummary)),

    section('Top 10 clientes (por verde aceptado · todo el periodo cargado)',
      byClient.length === 0
        ? emptyText('Sin pedidos con cliente registrado.')
        : sectionTable({
            headers: ['Cliente', 'Pedidos', 'Abiertos', 'Completados', 'Verde solicitado', 'Verde aceptado'],
            rows: byClient.map(([client, b]) => [
              client, String(b.pedidos), String(b.abiertos), String(b.completados),
              fmtKg(b.verdeSolicitado), fmtKg(b.verdeAceptado),
            ]),
            totals: null,
            csv: () => csvFromTable(
              ['Cliente','Pedidos','Abiertos','Completados','Verde_solicitado_kg','Verde_aceptado_kg'],
              byClient.map(([c, b]) => [c, b.pedidos, b.abiertos, b.completados,
                round2(b.verdeSolicitado), round2(b.verdeAceptado)]),
              'top-clientes',
            ),
          }),
    ),

    section('Por región',
      byRegion.length === 0
        ? emptyText('Sin pedidos con región registrada.')
        : sectionTable({
            headers: ['Región', 'Pedidos', 'Verde solicitado', 'Verde aceptado'],
            rows: byRegion.map(([region, b]) => [
              region, String(b.pedidos), fmtKg(b.verdeSolicitado), fmtKg(b.verdeAceptado),
            ]),
            totals: null,
            csv: () => csvFromTable(
              ['Region','Pedidos','Verde_solicitado_kg','Verde_aceptado_kg'],
              byRegion.map(([r, b]) => [r, b.pedidos, round2(b.verdeSolicitado), round2(b.verdeAceptado)]),
              'por-region',
            ),
          }),
    ),

    section('Por tipo de pedido',
      byOrderType.length === 0
        ? emptyText('Sin pedidos con tipo registrado.')
        : sectionTable({
            headers: ['Tipo', 'Pedidos', 'Verde solicitado', 'Verde aceptado'],
            rows: byOrderType.map(([type, b]) => [
              type, String(b.pedidos), fmtKg(b.verdeSolicitado), fmtKg(b.verdeAceptado),
            ]),
            totals: null,
            csv: () => csvFromTable(
              ['Tipo','Pedidos','Verde_solicitado_kg','Verde_aceptado_kg'],
              byOrderType.map(([t, b]) => [t, b.pedidos, round2(b.verdeSolicitado), round2(b.verdeAceptado)]),
              'por-tipo',
            ),
          }),
    ),
  ];
}

// ─── Section renderer ───────────────────────────────────────────────
function section(title, child) {
  return el('section', { class: 'mb-6' }, [
    el('h3', { class: 'eyebrow mb-2', text: title }),
    el('div', { class: 'ctrm-card' }, [child]),
  ]);
}

function sectionTable({ headers, rows, totals, csv, legend }) {
  const csvBtn = csv ? el('button', {
    class: 'ctrm-btn ctrm-btn-soft ctrm-btn-xs',
    type: 'button',
    onClick: () => csv(),
  }, ['↓ CSV']) : null;

  const wrap = el('div', {});
  wrap.append(el('div', {
    class: 'flex items-center justify-between gap-2 px-3 py-2 border-b border-sand',
  }, [
    legend ? legend : el('span', { class: 'text-[11px] text-ink-300', text: '' }),
    csvBtn,
  ]));
  wrap.append(tableEl(headers, rows, totals));
  return wrap;
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
      el('tr', {}, r.map((cell, i) => {
        const isObj = cell != null && typeof cell === 'object' && !(cell instanceof Node);
        const value = isObj ? cell.value : cell;
        const customClass = isObj ? cell.class : '';
        const baseClass = i === 0 ? 'font-mono text-navy font-semibold' : 'text-right font-mono';
        // If value is already a Node (e.g. mini bar), put it as a child.
        if (value instanceof Node) {
          return el('td', { class: baseClass }, [value]);
        }
        return el('td', { class: `${baseClass} ${customClass || ''}`.trim() }, [String(value)]);
      })),
    )),
    totalsRow ? el('tfoot', {}, [
      el('tr', { class: 'bg-cream' }, totalsRow.map((cell, i) =>
        el('td', {
          class: i === 0
            ? 'font-display font-bold uppercase tracking-loose text-navy'
            : 'text-right font-mono font-bold text-navy',
        }, [String(cell)]),
      )),
    ]) : null,
  ]);
  wrap.append(t);
  return wrap;
}

// ─── Mini stacked bar per month row ─────────────────────────────────
const STACK_COLORS = {
  created:   '#7e9ec1', // navy-soft (creados)
  accepted:  '#5d8b66', // forest    (aceptados)
  completed: '#3a6f4a', // forest-dark (completados)
  cancelled: '#9aa3ae', // ink-300   (cancelados)
  rejected:  '#c45a4f', // crit-red  (rechazados)
};

function miniStack(r, maxTotal) {
  const total = r.created + r.accepted + r.completed + r.cancelled + r.rejected;
  if (total === 0) return el('span', { class: 'text-ink-300 text-[11px]', text: '—' });
  const widthPct = Math.max(8, (total / maxTotal) * 100);  // proportional to max month
  const segs = [
    { key: 'created',   v: r.created,   color: STACK_COLORS.created,   label: 'Creados' },
    { key: 'accepted',  v: r.accepted,  color: STACK_COLORS.accepted,  label: 'Aceptados' },
    { key: 'completed', v: r.completed, color: STACK_COLORS.completed, label: 'Completados' },
    { key: 'cancelled', v: r.cancelled, color: STACK_COLORS.cancelled, label: 'Cancelados' },
    { key: 'rejected',  v: r.rejected,  color: STACK_COLORS.rejected,  label: 'Rechazados' },
  ].filter((s) => s.v > 0);

  return el('div', {
    class: 'inline-flex h-3 rounded-full overflow-hidden bg-sand min-w-[80px]',
    style: `width:${widthPct}%;max-width:160px;`,
    title: segs.map((s) => `${s.label}: ${s.v}`).join(' · '),
  }, segs.map((s) => el('div', {
    class: 'h-full',
    style: `flex:${s.v} 0 0;background:${s.color};`,
  })));
}

function stackLegend() {
  const items = [
    { color: STACK_COLORS.created,   label: 'Creados' },
    { color: STACK_COLORS.accepted,  label: 'Aceptados' },
    { color: STACK_COLORS.completed, label: 'Completados' },
    { color: STACK_COLORS.cancelled, label: 'Cancelados' },
    { color: STACK_COLORS.rejected,  label: 'Rechazados' },
  ];
  return el('div', {
    class: 'flex flex-wrap items-center gap-2 text-[10px] text-ink-500',
  }, items.map((it) => el('span', { class: 'inline-flex items-center gap-1' }, [
    el('span', { class: 'inline-block w-2 h-2 rounded-sm', style: `background:${it.color};` }),
    it.label,
  ])));
}

// ─── Rejected partials section ──────────────────────────────────────
function rejectedSection(s) {
  const stats = el('div', {
    class: 'flex flex-wrap gap-x-6 gap-y-2 px-3 py-3 border-b border-sand text-[12px] font-mono',
  }, [
    metaInline('Parciales rechazados', String(s.count)),
    metaInline('kg verde perdidos',    fmtKg(s.kg_green)),
    metaInline('kg seco asociados',    fmtKg(s.kg_dried)),
  ]);

  const reasonsTable = s.byReason.length === 0
    ? emptyText('Sin parciales rechazados en este rango.')
    : tableEl(
        ['Motivo', 'Parciales', 'kg seco', 'kg verde'],
        s.byReason.map(([reason, b]) => [
          reason, String(b.count), fmtKg(b.kg_dried), fmtKg(b.kg_green),
        ]),
        s.byReason.length > 1 ? [
          'TOTAL',
          String(sum(s.byReason, ([, b]) => b.count)),
          fmtKg(sum(s.byReason, ([, b]) => b.kg_dried)),
          fmtKg(sum(s.byReason, ([, b]) => b.kg_green)),
        ] : null,
      );

  const detailsTable = s.items.length === 0
    ? null
    : el('details', { class: 'border-t border-sand' }, [
        el('summary', {
          class: 'cursor-pointer px-3 py-2 text-[11px] uppercase tracking-loose text-ink-500 font-semibold',
        }, [`Detalle por parcial (${s.items.length})`]),
        tableEl(
          ['Bache', 'Referencia', 'Proceso', 'Parcial', 'kg seco', 'kg verde', 'Fecha', 'Motivo'],
          [...s.items]
            .sort((a, b) => (b.rejected_at || '').localeCompare(a.rejected_at || ''))
            .map((p) => [
              p.bache_code, p.reference_name || '—', p.process_type || '—',
              p.parcial_letter, fmtKg(p.kg_dried), fmtKg(p.kg_green_yield),
              fmtDate((p.rejected_at || '').slice(0, 10)),
              p.reason || '(sin motivo)',
            ]),
          null,
        ),
      ]);

  const csvBtn = el('button', {
    class: 'ctrm-btn ctrm-btn-soft ctrm-btn-xs',
    type: 'button',
    onClick: () => csvFromTable(
      ['Bache','Referencia','Proceso','Parcial','kg_seco','kg_verde','Fecha','Motivo'],
      s.items.map((p) => [
        p.bache_code, p.reference_name || '', p.process_type || '',
        p.parcial_letter, round2(p.kg_dried), round2(p.kg_green_yield),
        (p.rejected_at || '').slice(0, 10), p.reason || '',
      ]),
      'parciales-rechazados',
    ),
  }, ['↓ CSV']);

  const header = el('div', {
    class: 'flex items-center justify-between gap-2 px-3 py-2 border-b border-sand',
  }, [
    el('span', { class: 'text-[11px] text-ink-300', text: 'Total y motivos' }),
    s.items.length > 0 ? csvBtn : null,
  ]);

  const wrap = el('div', {});
  wrap.append(header, stats, reasonsTable);
  if (detailsTable) wrap.append(detailsTable);
  return wrap;
}

function metaInline(label, value) {
  return el('span', { class: 'inline-flex items-baseline gap-1.5' }, [
    el('span', { class: 'text-ink-300 uppercase tracking-loose text-[10px]', text: label }),
    el('strong', { class: 'text-ink-700', text: value }),
  ]);
}

// ─── CSV export ─────────────────────────────────────────────────────
function csvFromTable(headers, rows, basename) {
  try {
    const escape = (v) => {
      if (v == null) return '';
      const s = String(v);
      if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const lines = [headers.map(escape).join(',')];
    for (const r of rows) lines.push(r.map(escape).join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `${basename}-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    toast('No se pudo exportar el CSV: ' + e.message, 'error');
  }
}

// ─── Helpers ────────────────────────────────────────────────────────
function emptyText(t) {
  return el('p', { class: 'text-[12px] text-ink-300 italic px-4 py-3', text: t });
}

function sum(arr, getter) {
  return arr.reduce((s, x) => s + Number(getter(x) || 0), 0);
}

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }

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
