// Motor de planeación semanal. Inputs proyectados por día (cereza /
// despulpado / seco), estado actual de planta y cola de pedidos
// generan un plan de 7 días con baches sugeridos, capacidad usada y
// alertas. El plan se persiste en weekly_plans.

import { el, clear } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { fmtKg, fmtDate } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { currentQuery, updateHashQuery } from '../router.js';
import { withBusy } from '../ui/busy.js';

const DAY_LABELS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

export async function fincaPlaneacionView() {
  // Semana actual (lunes ISO). El query param ?week=YYYY-MM-DD permite navegar a otras.
  const today = new Date();
  const defaultMonday = isoMondayOf(today.toISOString().slice(0, 10));
  let weekStart = currentQuery().get('week') || defaultMonday;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) weekStart = defaultMonday;

  let state = null;  // { plan_row, snapshot, capacity, queue_summary, queue_orders }
  // Inputs en memoria: { 'YYYY-MM-DD': { cereza, despulpado, seco } }
  let inputs = {};

  async function load() {
    state = await api.weeklyPlanGet(weekStart);
    const stored = state.plan_row && state.plan_row.day_inputs;
    inputs = stored && Object.keys(stored).length > 0 ? { ...stored } : {};
  }
  await load();

  const root = el('div', {});

  function days() { return isoDays(weekStart); }

  function totalsFromInputs() {
    let cereza = 0, despulpado = 0, seco = 0;
    for (const d of days()) {
      const v = inputs[d] || {};
      cereza     += Number(v.cereza     || 0);
      despulpado += Number(v.despulpado || 0);
      seco       += Number(v.seco       || 0);
    }
    return { cereza, despulpado, seco };
  }

  async function recompute(btn) {
    try {
      const r = await withBusy(btn, 'Calculando…', () => api.weeklyPlanCompute({
        week_start_date: weekStart,
        day_inputs: inputs,
      }));
      state.plan_row = r.plan_row;
      // Re-load para snapshot fresh.
      await load();
      redraw();
      toast('Plan recalculado', 'success');
    } catch (e) {
      console.error('plan compute failed', e);
      toast(e.message || 'Error al calcular plan', 'error', 6000);
    }
  }

  function navigateWeek(deltaDays) {
    const d = new Date(weekStart + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + deltaDays);
    weekStart = d.toISOString().slice(0, 10);
    updateHashQuery({ week: weekStart });
    load().then(() => redraw()).catch((e) => toast(e.message, 'error'));
  }

  function redraw() {
    clear(root);
    const totals = totalsFromInputs();
    const cap = state.capacity || {};
    const snap = state.snapshot || {};

    root.append(
      // ── Header: navegación + meta ────────────────────────────────
      el('div', { class: 'mb-4 flex items-center justify-between gap-2 flex-wrap' }, [
        el('div', { class: 'flex items-center gap-2' }, [
          el('button', {
            type: 'button',
            class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
            onClick: () => navigateWeek(-7),
          }, ['← Semana anterior']),
          el('span', { class: 'font-display font-semibold text-navy text-[13px]',
            text: `Semana del ${fmtDate(weekStart)} al ${fmtDate(days()[6])}` }),
          el('button', {
            type: 'button',
            class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
            onClick: () => navigateWeek(7),
          }, ['Semana siguiente →']),
        ]),
        state.plan_row
          ? el('p', { class: 'text-[11px] font-mono text-ink-500',
              text: `Plan guardado ${fmtDate((state.plan_row.generated_at || '').slice(0, 10))}` })
          : el('p', { class: 'text-[11px] font-mono text-ink-300 italic', text: 'Sin plan calculado' }),
      ]),

      // ── Doble columna: inputs + estado de planta ──────────────────
      el('div', { class: 'grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4' }, [
        // Inputs (2 cols en lg)
        el('div', { class: 'ctrm-card overflow-hidden lg:col-span-2' }, [
          el('div', { class: 'px-3 py-2 bg-cream border-b border-sand flex items-center justify-between' }, [
            el('p', { class: 'eyebrow text-[10px]', text: 'Ingreso proyectado por día' }),
            el('p', { class: 'text-[11px] font-mono text-ink-500' }, [
              `Cereza `, el('strong', { class: 'text-navy', text: fmtKg(totals.cereza) }),
              `  ·  Despulpado `, el('strong', { class: 'text-navy', text: fmtKg(totals.despulpado) }),
              `  ·  Seco `, el('strong', { class: 'text-navy', text: fmtKg(totals.seco) }),
            ]),
          ]),
          inputsGrid(inputs, days()),
          el('div', { class: 'px-3 py-3 border-t border-sand bg-cream flex justify-end' }, [
            (() => {
              const btn = el('button', { class: 'ctrm-btn ctrm-btn-primary', type: 'button' }, ['Calcular plan']);
              btn.addEventListener('click', () => recompute(btn));
              return btn;
            })(),
          ]),
        ]),

        // Estado actual de planta
        el('div', { class: 'ctrm-card overflow-hidden' }, [
          el('div', { class: 'px-3 py-2 bg-cream border-b border-sand' }, [
            el('p', { class: 'eyebrow text-[10px]', text: 'Estado actual de la planta' }),
          ]),
          el('div', { class: 'p-3 space-y-2' }, [
            capacityBar('Fermentación', snap.fermentation_used_kg || 0, cap.fermentation_kg || 25000, '#7e9ec1'),
            capacityBar('Mecánico',     snap.mecanico_used_kg     || 0, cap.mecanico_kg     ||  5000, '#ddae3e'),
            capacityBar('Patios Natural', snap.patios_natural_used_kg || 0, cap.patios_natural_kg || 20000, '#a8b89c'),
            capacityBar('Patios H/L',     snap.patios_hl_used_kg     || 0, cap.patios_hl_kg     || 40000, '#5d8b66'),
          ]),
          el('div', { class: 'px-3 py-2 border-t border-sand bg-cream text-[11px] font-mono text-ink-700' }, [
            el('strong', { text: String(state.queue_summary?.orders_count || 0) }),
            ' pedidos en cola · ',
            el('strong', { text: fmtKg(state.queue_summary?.total_remaining_kg || 0) }),
            ' kg verde pendientes',
          ]),
        ]),
      ]),

      // ── Alertas ────────────────────────────────────────────────
      state.plan_row ? alertsBlock(state.plan_row, coverageFromPlan(state)) : null,

      // ── Plan diario ─────────────────────────────────────────────
      state.plan_row ? planTable(state.plan_row) : emptyPlanHint(),
    );
  }
  redraw();

  // ── Builders ──
  function inputsGrid(inputsRef, dayList) {
    const grid = el('div', { class: 'overflow-x-auto' });
    const table = el('table', { class: 'w-full text-[12px]' }, [
      el('thead', {}, [el('tr', { class: 'text-ink-300 uppercase tracking-loose' }, [
        el('th', { class: 'text-left px-3 py-2 font-display text-[10px] tracking-eyebrow' }, ['Día']),
        el('th', { class: 'text-right px-3 py-2 font-display text-[10px] tracking-eyebrow' }, ['Cereza (kg)']),
        el('th', { class: 'text-right px-3 py-2 font-display text-[10px] tracking-eyebrow' }, ['Despulpado (kg)']),
        el('th', { class: 'text-right px-3 py-2 font-display text-[10px] tracking-eyebrow' }, ['Seco (kg)']),
      ])]),
      el('tbody', {}, dayList.map((d, i) => {
        const v = inputsRef[d] || { cereza: '', despulpado: '', seco: '' };
        const mkInput = (field) => {
          const inp = el('input', {
            type: 'number', min: '0', step: '1',
            value: v[field] != null && v[field] !== '' ? String(v[field]) : '',
            class: 'ctrm-input mono text-right w-full',
            placeholder: '0',
          });
          inp.addEventListener('input', () => {
            if (!inputsRef[d]) inputsRef[d] = { cereza: 0, despulpado: 0, seco: 0 };
            inputsRef[d][field] = inp.value === '' ? 0 : Number(inp.value);
            // refrescar totales arriba sin re-render completo
            const t = totalsFromInputs();
            const totalsEl = grid.parentElement && grid.parentElement.previousElementSibling
              && grid.parentElement.previousElementSibling.querySelector('p:last-child');
            if (totalsEl) {
              clear(totalsEl);
              totalsEl.append(
                'Cereza ', el('strong', { class: 'text-navy', text: fmtKg(t.cereza) }),
                '  ·  Despulpado ', el('strong', { class: 'text-navy', text: fmtKg(t.despulpado) }),
                '  ·  Seco ', el('strong', { class: 'text-navy', text: fmtKg(t.seco) }),
              );
            }
          });
          return inp;
        };
        return el('tr', { class: 'border-t border-sand' }, [
          el('td', { class: 'px-3 py-1.5' }, [
            el('span', { class: 'font-display font-semibold text-navy text-[12px]', text: DAY_LABELS[i] }),
            el('span', { class: 'block text-[10px] font-mono text-ink-500', text: fmtDate(d) }),
          ]),
          el('td', { class: 'px-3 py-1.5' }, [mkInput('cereza')]),
          el('td', { class: 'px-3 py-1.5' }, [mkInput('despulpado')]),
          el('td', { class: 'px-3 py-1.5' }, [mkInput('seco')]),
        ]);
      })),
    ]);
    grid.append(table);
    return grid;
  }

  return chrome(el('div', {}, [
    pageTitle('Planeación', 'Motor de procesamiento semanal'),
    root,
  ]));
}

// ── Helpers ────────────────────────────────────────────────────────

function capacityBar(label, used, capacity, color) {
  const pct = capacity > 0 ? Math.min(100, (used / capacity) * 100) : 0;
  const danger = pct >= 90;
  return el('div', {}, [
    el('div', { class: 'flex items-baseline justify-between text-[11px] font-mono mb-1' }, [
      el('span', { class: 'text-ink-700', text: label }),
      el('span', {}, [
        el('strong', { class: danger ? 'text-crit' : 'text-navy', text: fmtKg(used) }),
        el('span', { class: 'text-ink-300', text: ` / ${fmtKg(capacity)}` }),
      ]),
    ]),
    el('div', { class: 'h-2 rounded-md bg-cream relative overflow-hidden border border-sand' }, [
      el('div', { class: 'h-full',
        style: `width:${pct}%;background:${danger ? '#c45a4f' : color};` }),
    ]),
  ]);
}

function alertsBlock(planRow, coverage) {
  const alerts = Array.isArray(planRow.alerts_json) ? planRow.alerts_json : [];
  const feasibility = planRow.feasibility_pct;
  return el('div', { class: 'ctrm-card overflow-hidden mb-4' }, [
    el('div', { class: 'px-3 py-2 bg-cream border-b border-sand flex items-center justify-between gap-2 flex-wrap' }, [
      el('p', { class: 'eyebrow text-[10px]', text: `Alertas (${alerts.length})` }),
      el('span', { class: 'text-[11px] font-mono text-ink-700' }, [
        coverage
          ? el('span', { class: 'mr-3' }, [
              'Cobertura: ',
              el('strong', { class: 'text-navy', text: fmtKg(coverage.covered_kg) }),
              el('span', { class: 'text-ink-300', text: ` / ${fmtKg(coverage.demand_kg)} verde` }),
            ])
          : null,
        'Factibilidad: ',
        el('strong', { class: feasibility >= 90 ? 'text-ok' : feasibility >= 70 ? 'text-warn' : 'text-crit',
          text: `${feasibility != null ? feasibility : '—'} %` }),
      ]),
    ]),
    alerts.length === 0
      ? el('p', { class: 'p-3 text-[12px] text-ink-300 italic', text: 'Plan sin alertas — todo cuadra con la capacidad actual.' })
      : el('ul', { class: 'p-3 space-y-1.5' }, alerts.map((a) => alertLine(a))),
  ]);
}

// Coverage = kg verde asignado a pedidos en el plan / kg verde demandado total.
function coverageFromPlan(state) {
  const plan = (state.plan_row && state.plan_row.plan_json) || [];
  let covered = 0;
  for (const d of plan) {
    for (const b of d.batches || []) {
      if (b.kind === 'order') covered += Number(b.kg_green || 0);
    }
  }
  const demand = Number(state.queue_summary?.total_remaining_kg || 0);
  return { covered_kg: Math.round(covered * 100) / 100, demand_kg: demand };
}

function alertLine(a) {
  const iconCls = a.kind === 'partial_coverage' ? 'text-warn'
                : a.kind === 'capacity_exceeded' ? 'text-crit'
                : a.kind === 'excess' ? 'text-ok'
                : 'text-ink-500';
  const icon = a.kind === 'capacity_exceeded' ? '⚠'
              : a.kind === 'partial_coverage' ? '⚠'
              : a.kind === 'excess' ? '✓'
              : '·';
  return el('li', { class: 'flex items-baseline gap-2 text-[12px]' }, [
    el('span', { class: `font-semibold ${iconCls}`, text: icon }),
    el('span', { class: 'text-ink-700', text: a.message }),
  ]);
}

function planTable(planRow) {
  const days = Array.isArray(planRow.plan_json) ? planRow.plan_json : [];
  return el('div', { class: 'ctrm-card overflow-hidden' }, [
    el('div', { class: 'px-3 py-2 bg-cream border-b border-sand' }, [
      el('p', { class: 'eyebrow text-[10px]', text: 'Plan diario sugerido' }),
    ]),
    el('div', { class: 'divide-y divide-sand' }, days.map((day, i) => planDayRow(day, i))),
  ]);
}

function planDayRow(day, idx) {
  const batches = day.batches || [];
  const arrivals = day.arrivals || { cereza: 0, despulpado: 0, seco: 0 };
  return el('div', { class: 'flex gap-4 px-3 py-3' }, [
    // Columna día + llegada
    el('div', { class: 'shrink-0 w-32' }, [
      el('p', { class: 'font-display font-semibold text-navy text-[14px]', text: DAY_LABELS[idx] }),
      el('p', { class: 'text-[11px] font-mono text-ink-500', text: fmtDate(day.date) }),
      el('div', { class: 'mt-2 space-y-0.5 text-[10px] font-mono text-ink-500' }, [
        arrivals.cereza > 0     ? el('p', {}, [`Cereza  `, el('strong', { class: 'text-ink-700', text: fmtKg(arrivals.cereza) })])     : null,
        arrivals.despulpado > 0 ? el('p', {}, [`Despulp. `, el('strong', { class: 'text-ink-700', text: fmtKg(arrivals.despulpado) })]) : null,
        arrivals.seco > 0       ? el('p', {}, [`Seco    `, el('strong', { class: 'text-ink-700', text: fmtKg(arrivals.seco) })])       : null,
        (arrivals.cereza + arrivals.despulpado + arrivals.seco) === 0
          ? el('p', { class: 'italic text-ink-300', text: 'Sin llegadas' })
          : null,
      ]),
    ]),
    // Columna batches
    el('div', { class: 'flex-1 min-w-0' }, [
      batches.length === 0
        ? el('p', { class: 'text-[12px] italic text-ink-300', text: 'Sin baches programados.' })
        : el('div', { class: 'space-y-1' }, batches.map((b) => batchLine(b))),
    ]),
    // Columna ocupación
    el('div', { class: 'shrink-0 w-32 text-[10px] font-mono text-ink-500 space-y-0.5' }, [
      el('p', {}, [
        `Ferm `,
        el('strong', { class: 'text-ink-700', text: fmtKg(day.ferm_used || 0) }),
      ]),
      el('p', {}, [`${batches.length} bache${batches.length === 1 ? '' : 's'}`]),
    ]),
  ]);
}

function batchLine(b) {
  const procColor = b.process_type === 'Natural' ? '#3a6f4a'
                  : b.process_type === 'Honey'   ? '#ddae3e'
                  : b.process_type === 'Lavado'  ? '#7e9ec1'
                  : '#9aa3ae';
  return el('div', {
    class: 'flex items-center gap-2 px-2 py-1.5 bg-cream rounded-md text-[11px] font-mono',
  }, [
    el('span', { class: 'shrink-0', style: `display:inline-block;width:8px;height:8px;border-radius:2px;background:${procColor};` }),
    el('span', { class: 'font-display font-semibold text-navy text-[11px]', text: b.process_type }),
    el('span', { class: 'text-ink-300', text: '·' }),
    el('span', { class: 'text-ink-700' }, [
      el('strong', { text: fmtKg(b.kg_input) }),
      ' ', b.stage_input, ' → ',
      el('strong', { text: fmtKg(b.kg_green) }),
      ' verde',
    ]),
    b.order_code
      ? el('span', { class: 'ctrm-code text-[10px]', title: `${b.order_code}${b.client_name ? ' · ' + b.client_name : ''}`, text: b.order_code })
      : el('span', { class: 'ctrm-pill text-[10px]', style: 'background:#fbe6c2;color:#8a5100;', text: 'A designar' }),
    b.reference_name
      ? el('span', { class: 'text-[10px] text-ink-500 truncate', text: b.reference_name })
      : null,
    b.target_dryer
      ? el('span', { class: 'ml-auto text-[10px] text-ink-500', text: `→ ${b.target_dryer}` })
      : null,
  ]);
}

function emptyPlanHint() {
  return el('div', { class: 'ctrm-card ctrm-card-pad text-center' }, [
    el('p', { class: 'text-[13px] text-ink-700' }, [
      'Ingresa las cantidades esperadas por día y presiona ',
      el('strong', { text: 'Calcular plan' }),
      ' para generar la programación de la semana.',
    ]),
  ]);
}

// ── Date helpers ──────────────────────────────────────────────────
function isoMondayOf(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  const day = d.getUTCDay() || 7; // 1..7, 1=lunes
  if (day !== 1) d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

function isoDays(weekStartDate) {
  const out = [];
  const d = new Date(weekStartDate + 'T00:00:00Z');
  for (let i = 0; i < 7; i++) {
    const day = new Date(d.getTime() + i * 86400000);
    out.push(day.toISOString().slice(0, 10));
  }
  return out;
}
