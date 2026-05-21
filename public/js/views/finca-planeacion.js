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

      // ── Pipeline de acciones operativas ─────────────────────────
      state.plan_row ? actionPipeline(state.plan_row) : null,

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
            capacityBar('Fermentación', snap.fermentation_used_kg || 0, cap.fermentation_kg || 40000, '#7e9ec1'),
            sharedCapacityBar('Mecánico', snap.mecanico_used_kg || 0, snap.mecanico_used_pct || 0, '#ddae3e'),
            sharedCapacityBar('Patios',   snap.patios_used_kg   || 0, snap.patios_used_pct   || 0, '#5d8b66'),
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

      // ── Heatmap de ocupación ───────────────────────────────────
      state.plan_row ? occupancyHeatmap(state.plan_row, state.capacity || {}) : null,

      // ── Balance por etapa (entradas / salidas por día) ─────────
      state.plan_row ? stageBalanceTable(state.plan_row) : null,

      // ── Mini-Gantt de baches ───────────────────────────────────
      state.plan_row ? ganttTable(state.plan_row) : null,

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
          ? el('span', { class: 'mr-3', title: 'Los pedidos se contabilizan en kg verde (producto final).' }, [
              'Cobertura de pedidos: ',
              el('strong', { class: 'text-navy',
                text: `${fmtKg(coverage.covered_kg)} / ${fmtKg(coverage.demand_kg)} kg verde` }),
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
// plan_json puede ser un array (formato legacy) o un objeto { days, flow, coverage }.
function planDays(planRow) {
  const p = planRow && planRow.plan_json;
  if (!p) return [];
  if (Array.isArray(p)) return p;
  return Array.isArray(p.days) ? p.days : [];
}
function planFlow(planRow) {
  const p = planRow && planRow.plan_json;
  if (!p || Array.isArray(p)) return null;
  return p.flow || null;
}
function coverageFromPlan(state) {
  // Si está en plan_json.coverage, usar; sino calcular desde batches.
  const stored = state.plan_row && state.plan_row.plan_json && state.plan_row.plan_json.coverage;
  if (stored) return stored;
  let covered = 0;
  for (const d of planDays(state.plan_row)) {
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
                : a.kind === 'suggestion' ? 'text-navy'
                : 'text-ink-500';
  const icon = a.kind === 'capacity_exceeded' ? '⚠'
              : a.kind === 'partial_coverage' ? '⚠'
              : a.kind === 'excess' ? '✓'
              : a.kind === 'suggestion' ? '💡'
              : '·';
  return el('li', { class: 'flex items-baseline gap-2 text-[12px]' }, [
    el('span', { class: `font-semibold ${iconCls}`, text: icon }),
    el('span', { class: 'text-ink-700', text: a.message }),
  ]);
}

// ── Pipeline de acciones operativas por día ────────────────────────
// Lista chronológica de qué hacer cada día: recibir, despulpar,
// iniciar baches, mover entre etapas, sacar a bodega, alertas.
function actionPipeline(planRow) {
  const flow = planFlow(planRow);
  if (!flow || !Array.isArray(flow.actions)) return null;

  const totalActions = flow.actions.reduce((s, d) => s + d.actions.length, 0);
  if (totalActions === 0) {
    return el('div', { class: 'ctrm-card ctrm-card-pad mb-4 text-center' }, [
      el('p', { class: 'text-[12px] text-ink-300 italic',
        text: 'No hay acciones programadas para esta semana.' }),
    ]);
  }

  return el('div', { class: 'ctrm-card overflow-hidden mb-4' }, [
    el('div', { class: 'px-3 py-2 bg-cream border-b border-sand' }, [
      el('p', { class: 'eyebrow text-[10px]', text: 'Plan de trabajo · qué hacer cada día' }),
    ]),
    el('div', { class: 'divide-y divide-sand' }, flow.actions.map((d, idx) =>
      actionDayBlock(d, idx))),
  ]);
}

function actionDayBlock(day, idx) {
  const acts = day.actions || [];
  return el('div', { class: 'flex gap-4 px-3 py-2.5' }, [
    el('div', { class: 'shrink-0 w-24' }, [
      el('p', { class: 'font-display font-semibold text-navy text-[13px]', text: DAY_LABELS[idx] }),
      el('p', { class: 'text-[10px] font-mono text-ink-500', text: fmtDate(day.date) }),
    ]),
    el('div', { class: 'flex-1 min-w-0' }, [
      acts.length === 0
        ? el('p', { class: 'text-[11px] italic text-ink-300', text: 'Sin actividad.' })
        : el('ul', { class: 'space-y-1' }, acts.map((a) => actionLine(a))),
    ]),
  ]);
}

function actionLine(a) {
  const cls = a.type === 'warning' ? 'text-crit'
            : a.type === 'suggestion' ? 'text-navy'
            : a.type === 'arrival' ? 'text-ok'
            : a.type === 'ready' ? 'text-ok'
            : a.type === 'transition' ? 'text-warn'
            : 'text-ink-500';
  const procColor = a.process === 'Natural' ? '#3a6f4a'
                  : a.process === 'Honey'   ? '#ddae3e'
                  : a.process === 'Lavado'  ? '#7e9ec1'
                  : null;
  return el('li', { class: 'flex items-baseline gap-2 text-[12px]' }, [
    procColor
      ? el('span', { class: 'shrink-0', style: `display:inline-block;width:6px;height:6px;border-radius:1px;background:${procColor};margin-top:1px;` })
      : el('span', { class: 'shrink-0', style: 'display:inline-block;width:6px;' }),
    el('span', { class: `font-semibold ${cls} shrink-0`, text: a.icon }),
    el('span', { class: 'text-ink-700', text: a.text }),
  ]);
}

// ── Heatmap de ocupación por recurso × día ─────────────────────────
// Filas: fermentación, mecánico, patios N, patios H/L.
// Columnas: 7 días. Cada celda: kg usados / capacidad + color semáforo.
// Recursos del heatmap. Fermentación tiene capacidad en kg físicos
// (40k). Mecánico y Patios son compartidos entre procesos: la
// 'capacidad' efectiva se mide como fracción (suma de kg/cap_proceso
// por bache) — saturado al 100%.
const RESOURCES = [
  { key: 'fermentation', label: 'Fermentación', cap_kg: 40000, shared: false },
  { key: 'mecanico',     label: 'Mecánico',     shared: true, sub: 'N 12k · H/L 10k' },
  { key: 'patios',       label: 'Patios',       shared: true, sub: 'N 60k · H/L 100k' },
];

function occupancyHeatmap(planRow, capacity) {
  const flow = planFlow(planRow);
  if (!flow || !flow.daily_occupancy) return null;
  const days = planDays(planRow).map((d) => d.date);
  const occ = flow.daily_occupancy;

  return el('div', { class: 'ctrm-card overflow-hidden mb-4' }, [
    el('div', { class: 'px-3 py-2 bg-cream border-b border-sand' }, [
      el('p', { class: 'eyebrow text-[10px]', text: 'Cuellos de botella — kg físicos en planta por día' }),
    ]),
    el('div', { class: 'overflow-x-auto' }, [
      el('table', { class: 'w-full text-[11px] font-mono' }, [
        el('thead', {}, [el('tr', { class: 'border-b border-sand' }, [
          el('th', { class: 'text-left px-3 py-2 font-display text-[10px] uppercase tracking-eyebrow text-ink-500', text: 'Recurso' }),
          ...days.map((d, i) => el('th', {
            class: 'text-center px-2 py-2 font-display text-[10px] uppercase tracking-eyebrow text-ink-500',
          }, [
            el('div', {}, [DAY_LABELS[i]]),
            el('div', { class: 'text-ink-300 text-[9px]', text: fmtDate(d) }),
          ])),
          el('th', { class: 'text-right px-3 py-2 font-display text-[10px] uppercase tracking-eyebrow text-ink-500', text: 'Capacidad' }),
        ])]),
        el('tbody', {}, RESOURCES.map((r) => {
          const cells = days.map((d) => {
            const day = occ[d] || {};
            if (r.shared) {
              const kg  = Number(day[r.key + '_kg']   || 0);
              const pct = Number(day[r.key + '_frac'] || 0) * 100;
              return heatCellPct(kg, pct);
            }
            return heatCellKg(Number(day[r.key] || 0), r.cap_kg);
          });
          return el('tr', { class: 'border-b border-sand' }, [
            el('td', { class: 'px-3 py-1.5' }, [
              el('div', { class: 'text-navy font-display font-semibold text-[11px]', text: r.label }),
              r.sub
                ? el('div', { class: 'text-[9px] text-ink-300', text: r.sub })
                : null,
            ]),
            ...cells,
            el('td', { class: 'px-3 py-1.5 text-right text-ink-500',
              text: r.shared ? 'Compartido' : `${fmtKg(r.cap_kg)} kg` }),
          ]);
        })),
      ]),
    ]),
    el('div', { class: 'px-3 py-2 border-t border-sand bg-cream text-[10px] font-mono text-ink-500' }, [
      'Mecánico y patios son recursos compartidos: el % suma fracciones por proceso (cereza Natural ocupa 1/12k mec ó 1/60k patios por kg; despulpado H/L ocupa 1/10k ó 1/100k). Saturado al 100%.',
    ]),
  ]);
}

function heatCellKg(used, cap) {
  const pct = cap > 0 ? (used / cap) * 100 : 0;
  return paintCell(used, pct, `${fmtKg(used)} kg`);
}

function heatCellPct(used_kg, pct) {
  return paintCell(used_kg, pct, `${Math.round(pct)}%`, `${fmtKg(used_kg)} kg`);
}

function paintCell(used, pct, primary, secondary) {
  let bg = 'transparent', color = '#5a6371';
  if (pct >= 100) { bg = '#c45a4f'; color = 'white'; }
  else if (pct >= 80) { bg = '#ddae3e'; color = '#3d2a00'; }
  else if (pct >= 50) { bg = '#f1e5c4'; color = '#3a4255'; }
  else if (used > 0) { bg = '#e8efe3'; color = '#3a4255'; }
  return el('td', {
    class: 'text-center px-2 py-1.5',
    style: `background:${bg};color:${color};`,
  }, [
    el('div', { class: 'font-semibold text-[12px]', text: used > 0 ? primary : '—' }),
    used > 0 && secondary
      ? el('div', { class: 'text-[9px] opacity-75', text: secondary })
      : (used > 0 && !secondary ? el('div', { class: 'text-[9px] opacity-75', text: `${Math.round(pct)}%` }) : null),
  ]);
}

// Barra de capacidad para recurso compartido: el % es fracción suma,
// los kg son la masa física total.
function sharedCapacityBar(label, used_kg, used_pct, color) {
  const pct = Math.min(100, used_pct || 0);
  const danger = used_pct >= 90;
  return el('div', {}, [
    el('div', { class: 'flex items-baseline justify-between text-[11px] font-mono mb-1' }, [
      el('span', { class: 'text-ink-700' }, [
        label,
        el('span', { class: 'text-ink-300 text-[10px]', text: ' (compartido)' }),
      ]),
      el('span', {}, [
        el('strong', { class: danger ? 'text-crit' : 'text-navy',
          text: `${Math.round(used_pct || 0)}%` }),
        el('span', { class: 'text-ink-300', text: `  ${fmtKg(used_kg)} kg` }),
      ]),
    ]),
    el('div', { class: 'h-2 rounded-md bg-cream relative overflow-hidden border border-sand' }, [
      el('div', { class: 'h-full',
        style: `width:${pct}%;background:${danger ? '#c45a4f' : color};` }),
    ]),
  ]);
}

// ── Balance por etapa: kg entrando y saliendo cada día ─────────────
// Filas: Fermentación, Secado, Reposo, Listo para bodega.
// Cada celda muestra '↓ X / ↑ Y' (entrando / saliendo). Última col:
// total semanal.
const STAGE_BALANCE_ROWS = [
  { key: 'fermentation', label: 'Fermentación' },
  { key: 'drying',       label: 'Secado' },
  { key: 'resting',      label: 'Reposo' },
  { key: 'ready',        label: 'Listo p/ bodega' },
];

function stageBalanceTable(planRow) {
  const flow = planFlow(planRow);
  if (!flow || !flow.stage_balance) return null;
  const days = planDays(planRow).map((d) => d.date);
  const bal = flow.stage_balance;

  return el('div', { class: 'ctrm-card overflow-hidden mb-4' }, [
    el('div', { class: 'px-3 py-2 bg-cream border-b border-sand flex items-center justify-between' }, [
      el('p', { class: 'eyebrow text-[10px]', text: 'Flujo por etapa — entradas y salidas por día' }),
      el('p', { class: 'text-[10px] font-mono text-ink-500' }, [
        el('span', { class: 'text-ok font-semibold', text: '↓' }), ' entra  ',
        el('span', { class: 'text-warn font-semibold', text: '↑' }), ' sale',
      ]),
    ]),
    el('div', { class: 'overflow-x-auto' }, [
      el('table', { class: 'w-full text-[11px] font-mono' }, [
        el('thead', {}, [el('tr', { class: 'border-b border-sand' }, [
          el('th', { class: 'text-left px-3 py-2 font-display text-[10px] uppercase tracking-eyebrow text-ink-500', text: 'Etapa' }),
          ...days.map((d, i) => el('th', {
            class: 'text-center px-2 py-2 font-display text-[10px] uppercase tracking-eyebrow text-ink-500',
          }, [
            el('div', {}, [DAY_LABELS[i]]),
            el('div', { class: 'text-ink-300 text-[9px]', text: fmtDate(d) }),
          ])),
          el('th', { class: 'text-right px-3 py-2 font-display text-[10px] uppercase tracking-eyebrow text-ink-500', text: 'Semana' }),
        ])]),
        el('tbody', {}, STAGE_BALANCE_ROWS.map((row) => {
          let weekIn = 0, weekOut = 0;
          const cells = days.map((d) => {
            const b = (bal[d] || {})[row.key] || { in: 0, out: 0 };
            weekIn  += b.in;
            weekOut += b.out;
            return stageBalanceCell(b, row.key);
          });
          return el('tr', { class: 'border-b border-sand' }, [
            el('td', { class: 'px-3 py-1.5 text-navy font-display font-semibold text-[11px]', text: row.label }),
            ...cells,
            el('td', { class: 'px-3 py-1.5 text-right text-[10px]' }, [
              weekIn > 0 ? el('div', { class: 'text-ok font-semibold', text: `↓ ${fmtKg(weekIn)}` }) : null,
              weekOut > 0 ? el('div', { class: 'text-warn font-semibold', text: `↑ ${fmtKg(weekOut)}` }) : null,
              weekIn === 0 && weekOut === 0 ? el('span', { class: 'text-ink-300', text: '—' }) : null,
            ]),
          ]);
        })),
      ]),
    ]),
    el('div', { class: 'px-3 py-2 border-t border-sand bg-cream text-[10px] font-mono text-ink-500' }, [
      'Cantidades en kg de input bruto (cereza/despulpado/seco según el origen del bache). El "Listo p/ bodega" muestra los kg que salen de reposo y pasan a trilla/bodega.',
    ]),
  ]);
}

function stageBalanceCell(b, stageKey) {
  if (b.in === 0 && b.out === 0) {
    return el('td', { class: 'text-center px-1 py-1.5 text-ink-300', text: '·' });
  }
  return el('td', { class: 'text-center px-1 py-1.5' }, [
    b.in > 0
      ? el('div', { class: 'text-ok text-[10px] font-semibold', text: `↓ ${fmtKg(b.in)}` })
      : null,
    // 'ready' usa 'in' como "llega a bodega": no mostramos 'out'.
    b.out > 0 && stageKey !== 'ready'
      ? el('div', { class: 'text-warn text-[10px] font-semibold', text: `↑ ${fmtKg(b.out)}` })
      : null,
  ]);
}

// ── Mini-Gantt: filas baches, columnas días, celdas etapas ─────────
function ganttTable(planRow) {
  const flow = planFlow(planRow);
  if (!flow || !Array.isArray(flow.gantt) || flow.gantt.length === 0) return null;
  const days = planDays(planRow).map((d) => d.date);
  const dayIdx = Object.fromEntries(days.map((d, i) => [d, i]));

  // Ordenar: reales primero, luego planeados por start_date.
  const rows = [...flow.gantt].sort((a, b) => {
    if (a.kind === 'real' && b.kind !== 'real') return -1;
    if (b.kind === 'real' && a.kind !== 'real') return 1;
    return (a.start_date || '').localeCompare(b.start_date || '');
  });

  return el('div', { class: 'ctrm-card overflow-hidden mb-4' }, [
    el('div', { class: 'px-3 py-2 bg-cream border-b border-sand flex items-center justify-between' }, [
      el('p', { class: 'eyebrow text-[10px]', text: `Cronograma de baches (${rows.length})` }),
      el('p', { class: 'text-[10px] font-mono text-ink-500' }, [
        legendDot('#7e9ec1'), ' Ferm  ',
        legendDot('#ddae3e'), ' Mec  ',
        legendDot('#a8b89c'), ' Pat N  ',
        legendDot('#5d8b66'), ' Pat H/L',
      ]),
    ]),
    el('div', { class: 'overflow-x-auto' }, [
      el('table', { class: 'w-full text-[11px]' }, [
        el('thead', {}, [el('tr', { class: 'border-b border-sand' }, [
          el('th', { class: 'text-left px-3 py-2 font-display text-[10px] uppercase tracking-eyebrow text-ink-500', text: 'Bache' }),
          ...days.map((d, i) => el('th', {
            class: 'text-center px-1 py-2 font-display text-[10px] uppercase tracking-eyebrow text-ink-500',
            text: DAY_LABELS[i],
          })),
        ])]),
        el('tbody', {}, rows.map((row) => ganttRow(row, days, dayIdx))),
      ]),
    ]),
  ]);
}

function legendDot(color) {
  return el('span', { style: `display:inline-block;width:8px;height:8px;border-radius:2px;background:${color};vertical-align:middle;` });
}

function ganttRow(row, days, dayIdx) {
  // Marcar cada día con la etapa más relevante de ese día (si hay).
  const cells = days.map(() => null);
  for (const s of row.stages || []) {
    const fromI = dayIdx[s.from];
    const toI = dayIdx[s.to];
    // Si la etapa cae fuera de la ventana, marcar bordes.
    const start = fromI != null ? fromI : (s.from < days[0] ? 0 : -1);
    const end   = toI != null ? toI : (s.to > days[6] ? 6 : -1);
    if (start < 0 || end < 0) continue;
    for (let i = start; i <= end; i++) {
      cells[i] = { stage: s.stage, resource: s.resource };
    }
  }
  const procColor = row.process === 'Natural' ? '#3a6f4a'
                  : row.process === 'Honey'   ? '#ddae3e'
                  : row.process === 'Lavado'  ? '#7e9ec1'
                  : '#9aa3ae';
  return el('tr', { class: 'border-b border-sand hover:bg-cream/40' }, [
    el('td', { class: 'px-3 py-1.5 whitespace-nowrap' }, [
      el('div', { class: 'flex items-center gap-2' }, [
        el('span', { style: `display:inline-block;width:8px;height:8px;border-radius:2px;background:${procColor};` }),
        row.kind === 'real'
          ? el('span', { class: 'ctrm-pill text-[9px]', style: 'background:#e8efe3;color:#2e4a2e;', text: 'En curso' })
          : row.kind === 'excess'
            ? el('span', { class: 'ctrm-pill text-[9px]', style: 'background:#fbe6c2;color:#8a5100;', text: 'A designar' })
            : null,
        el('span', { class: 'font-display font-semibold text-navy text-[11px]', text: row.label }),
        // Planeados: mostrar el input (kg cereza / despulpado / seco).
        // Reales: ya están en proceso, mostramos kg en planta.
        row.kind === 'real'
          ? el('span', { class: 'text-[10px] font-mono text-ink-500', text: `${fmtKg(row.kg_green)} kg en planta` })
          : el('span', { class: 'text-[10px] font-mono text-ink-500',
              text: `${fmtKg(row.kg_input)} kg ${row.stage_input}` }),
      ]),
      row.reference_name
        ? el('div', { class: 'text-[10px] text-ink-500 truncate', text: row.reference_name + (row.client_name ? ' · ' + row.client_name : '') })
        : null,
    ]),
    ...cells.map((c) => ganttCell(c)),
  ]);
}

function ganttCell(c) {
  if (!c) return el('td', { class: 'px-1 py-1.5' });
  const colors = {
    fermentation:   { bg: '#7e9ec1', fg: 'white' },
    mecanico:       { bg: '#ddae3e', fg: '#3d2a00' },
    patios_natural: { bg: '#a8b89c', fg: '#1f2d23' },
    patios_hl:      { bg: '#5d8b66', fg: 'white' },
  }[c.resource] || { bg: '#cbd5db', fg: '#3a4255' };
  return el('td', { class: 'px-1 py-1.5' }, [
    el('div', {
      class: 'text-center text-[9px] font-display font-semibold uppercase tracking-eyebrow rounded-sm py-1',
      style: `background:${colors.bg};color:${colors.fg};`,
      text: c.stage,
    }),
  ]);
}

function planTable(planRow) {
  const days = planDays(planRow);
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
      ' kg ', b.stage_input,
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
