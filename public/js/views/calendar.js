// Month-grid calendar — entregas (planeadas y reales) y drying-starts.
// Events come from already-public endpoints; aggregation is client-side.

import { el, clear } from '../ui/el.js';
import { fmtKg, fmtDate, statusLabel, URGENCY_LABEL } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { navigate } from '../router.js';

const WEEKDAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

// Event kinds — kind controls the dot color via CSS classes.
const KIND = {
  ENTREGA_PLAN: 'entrega-plan',   // order max_delivery_date (in-flight)
  DRYING_PLAN:  'drying-plan',    // order latest_drying_start_date (in-flight)
  DESPACHO:     'despacho',       // shipment_date (real)
  DRYING_REAL:  'drying-real',    // lot drying_start_date
  LOTE_LISTO:   'lote-listo',     // lot ready_date
};

const KIND_LABEL = {
  [KIND.ENTREGA_PLAN]: 'Entrega plan',
  [KIND.DRYING_PLAN]:  'Inicio drying plan',
  [KIND.DESPACHO]:     'Despacho real',
  [KIND.DRYING_REAL]:  'Drying iniciado',
  [KIND.LOTE_LISTO]:   'Lote listo',
};

export async function calendarView() {
  const [ordersRes, lotsRes, shipsRes] = await Promise.all([
    api.ordersList({}),
    api.lotsList({}),
    api.shipmentsList(),
  ]);
  const today = ordersRes.today;
  const orders = ordersRes.orders || [];
  const lots = lotsRes.lots || [];
  const shipments = shipsRes.shipments || [];

  // ── Build events ─────────────────────────────────────────────────
  const events = [];
  const inFlightStatuses = new Set(['Accepted', 'PartiallyAccepted', 'InProduction']);

  for (const o of orders) {
    if (inFlightStatuses.has(o.status)) {
      if (o.max_delivery_date) {
        events.push({
          date: o.max_delivery_date.slice(0, 10),
          kind: KIND.ENTREGA_PLAN,
          urgency: o.delivery_urgency,
          title: o.order_code,
          subtitle: o.reference_name || '—',
          meta: `${statusLabel(o.status)} · ${fmtKg(o.kg_green_accepted ?? o.kg_green_required)}`,
          onClick: () => navigate('/finca/lots'),
        });
      }
      if (o.latest_drying_start_date) {
        events.push({
          date: o.latest_drying_start_date.slice(0, 10),
          kind: KIND.DRYING_PLAN,
          urgency: o.drying_urgency,
          title: o.order_code,
          subtitle: o.reference_name || '—',
          meta: `${statusLabel(o.status)} · ${o.process_type}`,
          onClick: () => navigate('/finca/lots'),
        });
      }
    }
  }

  for (const s of shipments) {
    if (s.shipment_date) {
      events.push({
        date: s.shipment_date.slice(0, 10),
        kind: KIND.DESPACHO,
        title: s.shipment_code,
        subtitle: `${s.totals?.lot_count ?? s.lots.length} lote(s)`,
        meta: fmtKg(s.totals?.kg_green || 0),
        onClick: () => navigate('/finca/despachos'),
      });
    }
  }

  for (const l of lots) {
    if (l.drying_start_date) {
      events.push({
        date: l.drying_start_date.slice(0, 10),
        kind: KIND.DRYING_REAL,
        title: l.bache_code || l.lot_code,
        subtitle: l.reference_name || '—',
        meta: `${statusLabel(l.status)} · ${l.process_type}`,
        onClick: () => navigate('/finca/lots'),
      });
    }
    if (l.ready_date && l.status === 'Ready') {
      events.push({
        date: l.ready_date.slice(0, 10),
        kind: KIND.LOTE_LISTO,
        title: l.bache_code || l.lot_code,
        subtitle: l.reference_name || '—',
        meta: `${fmtKg(l.kg_green_actual ?? l.kg_green_expected ?? 0)}`,
        onClick: () => navigate('/finca/lots'),
      });
    }
  }

  // Group events by ISO date.
  const byDate = new Map();
  for (const ev of events) {
    if (!byDate.has(ev.date)) byDate.set(ev.date, []);
    byDate.get(ev.date).push(ev);
  }

  // ── State (current month + selected day) ─────────────────────────
  const [ty, tm] = today.split('-').map(Number);
  let curYear  = ty;
  let curMonth = tm;        // 1..12
  let selectedDate = today; // ISO yyyy-mm-dd

  const root = el('div', {});
  function rerender() {
    clear(root);
    root.append(buildMonth());
  }

  function buildMonth() {
    const monthKey = `${curYear}-${String(curMonth).padStart(2, '0')}`;
    const eventsThisMonth = events.filter((e) => e.date.slice(0, 7) === monthKey);

    // Header strip with prev/next + month label
    const header = el('div', { class: 'flex items-center justify-between gap-2 mb-3' }, [
      el('button', {
        class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm', type: 'button',
        onClick: () => { stepMonth(-1); rerender(); },
      }, ['← Mes anterior']),
      el('div', { class: 'font-display font-bold text-navy uppercase tracking-loose text-[14px]' },
        [`${MONTH_NAMES[curMonth - 1]} ${curYear}`]),
      el('button', {
        class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm', type: 'button',
        onClick: () => { stepMonth(1); rerender(); },
      }, ['Mes siguiente →']),
    ]);

    // Legend
    const legend = el('div', { class: 'flex flex-wrap gap-2 mb-3 text-[11px] font-mono text-ink-500' },
      Object.entries(KIND_LABEL).map(([k, label]) =>
        el('span', { class: 'inline-flex items-center gap-1.5' }, [
          el('span', { class: `cal-dot cal-dot-${k}` }),
          el('span', { text: label }),
        ]),
      ),
    );

    // Build the day-cell grid (Monday-first, 6 weeks max).
    const gridDays = monthGridDays(curYear, curMonth);
    const grid = el('div', { class: 'grid grid-cols-7 gap-1' }, [
      // Weekday header row
      ...WEEKDAYS.map((w) => el('div', {
        class: 'text-center text-[10px] font-display uppercase tracking-loose text-ink-300 py-1',
        text: w,
      })),
      // Day cells
      ...gridDays.map((d) => dayCell(d)),
    ]);

    // Selected-day panel
    const panel = selectedDayPanel();

    // Month totals strip
    const totals = monthTotalsStrip(eventsThisMonth);

    return el('div', {}, [
      header,
      legend,
      el('div', { class: 'ctrm-card ctrm-card-pad mb-3' }, [grid]),
      totals,
      panel,
    ]);
  }

  function dayCell({ iso, year, month, day, inMonth }) {
    const dayEvents = byDate.get(iso) || [];
    const isToday = iso === today;
    const isSelected = iso === selectedDate;
    const cls = [
      'cal-cell',
      inMonth ? '' : 'cal-cell-out',
      isToday ? 'cal-cell-today' : '',
      isSelected ? 'cal-cell-selected' : '',
    ].filter(Boolean).join(' ');

    // Up to 3 dots; "+N" if more.
    const dotsRow = el('div', { class: 'flex flex-wrap gap-0.5 mt-0.5 justify-center' },
      [
        ...dayEvents.slice(0, 3).map((ev) =>
          el('span', { class: `cal-dot cal-dot-${ev.kind}${ev.urgency === 'past' || ev.urgency === 'red' ? ' is-urgent' : ''}` }),
        ),
        dayEvents.length > 3
          ? el('span', { class: 'text-[9px] text-ink-500 font-mono leading-none', text: `+${dayEvents.length - 3}` })
          : null,
      ],
    );

    return el('button', {
      type: 'button',
      class: cls,
      onClick: () => { selectedDate = iso; rerender(); },
    }, [
      el('span', { class: 'cal-cell-num', text: String(day) }),
      dotsRow,
    ]);
  }

  function selectedDayPanel() {
    const dayEvents = (byDate.get(selectedDate) || [])
      .slice()
      .sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind));
    return el('section', {}, [
      el('h3', { class: 'eyebrow mb-2', text: fmtDate(selectedDate) }),
      dayEvents.length === 0
        ? el('div', { class: 'ctrm-card ctrm-card-pad' }, [
            el('p', { class: 'text-[12px] text-ink-300 italic', text: 'Sin eventos este día.' }),
          ])
        : el('div', { class: 'space-y-2' }, dayEvents.map(eventRow)),
    ]);
  }

  function eventRow(ev) {
    const urg = ev.urgency && ev.urgency !== 'normal'
      ? el('span', { class: `ctrm-pill urgency-${ev.urgency}`, text: URGENCY_LABEL[ev.urgency] || ev.urgency })
      : null;
    return el('button', {
      type: 'button',
      class: 'ctrm-card ctrm-card-pad text-left w-full hover:border-navy',
      onClick: ev.onClick || (() => {}),
    }, [
      el('div', { class: 'flex items-center justify-between gap-2 mb-1 flex-wrap' }, [
        el('div', { class: 'flex items-center gap-2 flex-wrap min-w-0' }, [
          el('span', { class: `cal-dot cal-dot-${ev.kind}` }),
          el('span', {
            class: 'text-[10px] font-display uppercase tracking-loose text-ink-500',
            text: KIND_LABEL[ev.kind] || ev.kind,
          }),
          el('span', { class: 'ctrm-code', text: ev.title }),
          el('span', { class: 'text-[12px] font-display font-semibold text-navy truncate', text: ev.subtitle }),
        ]),
        urg,
      ]),
      el('p', { class: 'text-[11px] text-ink-500 font-mono', text: ev.meta }),
    ]);
  }

  function monthTotalsStrip(monthEvents) {
    const counts = new Map();
    for (const ev of monthEvents) counts.set(ev.kind, (counts.get(ev.kind) || 0) + 1);
    return el('div', { class: 'grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4' },
      Object.values(KIND).map((k) =>
        el('div', { class: 'stat-card' }, [
          el('p', { class: 'stat-label', text: KIND_LABEL[k] }),
          el('p', { class: 'stat-val', text: String(counts.get(k) || 0) }),
        ]),
      ),
    );
  }

  function stepMonth(delta) {
    let m = curMonth + delta;
    let y = curYear;
    while (m < 1)  { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    curMonth = m; curYear = y;
    // Snap selectedDate to the 1st of the new month if it isn't visible.
    const newKey = `${y}-${String(m).padStart(2, '0')}`;
    if (!selectedDate.startsWith(newKey)) selectedDate = `${newKey}-01`;
  }

  rerender();
  return chrome(el('div', {}, [
    pageTitle('Calendario', `Hoy: ${today} · ${events.length} evento(s) cargado(s)`),
    root,
  ]));
}

// ── Helpers ────────────────────────────────────────────────────────

// Returns 6 weeks (42 cells) starting on Monday, covering the given month.
function monthGridDays(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstDow = (first.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const start = new Date(first);
  start.setUTCDate(first.getUTCDate() - firstDow);

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    cells.push({
      iso: `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      year: y, month: m, day,
      inMonth: m === month && y === year,
    });
  }
  return cells;
}

function kindOrder(k) {
  const order = [KIND.ENTREGA_PLAN, KIND.DRYING_PLAN, KIND.DRYING_REAL, KIND.LOTE_LISTO, KIND.DESPACHO];
  const i = order.indexOf(k);
  return i < 0 ? 99 : i;
}
