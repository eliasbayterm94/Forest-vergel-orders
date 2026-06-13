// Tablero de Control — vista de operarios con cards por lote en
// proceso, contador de días, colores de urgencia y acciones rápidas.
import { el, clear } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { fmtKg, fmtDate, statusLabel, statusPillKind } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { navigate } from '../router.js';
import {
  NEXT_TRANSITIONS,
  advanceStatus as advanceStatusShared,
} from './_bache-actions.js';

// ── Parámetros de tiempo por etapa/proceso (días) ──────────────
const TIME_LIMITS = {
  InFermentation: { warn: 2, crit: 3 },
  Drying: {
    Natural: { warn: 25, crit: 30 },
    Honey:   { warn: 14, crit: 18 },
    Lavado:  { warn: 12, crit: 15 },
    _default: { warn: 20, crit: 25 },
  },
  Resting: { warn: 25, crit: 30 },
};

// ── Stepper del proceso ────────────────────────────────────────
// Muestra los 4 pasos del beneficio con el actual resaltado.
// Color por etapa solo en el punto activo (no choca con la urgencia
// del borde izquierdo de la card).
const STAGE_ORDER  = ['InFermentation', 'Drying', 'Resting', 'Ready'];
const STAGE_SHORT  = {
  InFermentation: 'Ferment.',
  Drying:         'Secado',
  Resting:        'Descanso',
  Ready:          'Listo',
};
const STAGE_COLOR  = {
  InFermentation: '#c62828',
  Drying:         '#e65100',
  Resting:        '#2e7d32',
  Ready:          '#1565c0',
};

function processStepper(currentStatus) {
  const cur = STAGE_ORDER.indexOf(currentStatus);
  const nodes = [];
  STAGE_ORDER.forEach((stage, i) => {
    const isDone    = i < cur;
    const isCurrent = i === cur;

    let dotStyle, dotText, labelClass;
    if (isCurrent) {
      dotStyle = `background:${STAGE_COLOR[stage]};color:#fff;border:2px solid ${STAGE_COLOR[stage]};`;
      dotText  = '●';
      labelClass = 'text-[10px] font-bold uppercase tracking-wide text-navy';
    } else if (isDone) {
      dotStyle = 'background:#2e7d32;color:#fff;border:2px solid #2e7d32;';
      dotText  = '✓';
      labelClass = 'text-[10px] text-ink-500';
    } else {
      dotStyle = 'background:#fff;color:#bdbdb6;border:1.5px solid #e8e8e2;';
      dotText  = '';
      labelClass = 'text-[10px] text-ink-300';
    }

    const dot = el('div', {
      class: 'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0',
      style: dotStyle,
      text: dotText,
    });
    const label = el('span', { class: labelClass, text: STAGE_SHORT[stage] });
    nodes.push(el('div', { class: 'flex items-center gap-1 shrink-0' }, [dot, label]));
    if (i < STAGE_ORDER.length - 1) {
      const connColor = (i < cur) ? '#2e7d32' : '#e8e8e2';
      nodes.push(el('div', { class: 'flex-1 h-0.5 mx-1 min-w-[8px]', style: `background:${connColor};` }));
    }
  });
  return el('div', { class: 'flex items-center mb-3 px-1' }, nodes);
}

function getLimits(status, processType) {
  const entry = TIME_LIMITS[status];
  if (!entry) return { warn: 999, crit: 999 };
  if (entry.warn != null) return entry;
  return entry[processType] || entry._default || { warn: 20, crit: 25 };
}

function daysSince(dateStr) {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  const now = new Date();
  return Math.max(0, Math.floor((now - d) / 86400000));
}

// Horas reales transcurridas entre dos timestamps ISO. Si endIso es
// null, usa el momento actual (útil para "lleva X horas en marcha").
function hoursBetween(startIso, endIso) {
  if (!startIso) return null;
  const start = new Date(startIso).getTime();
  if (!Number.isFinite(start)) return null;
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  return Math.max(0, (end - start) / 3600000);
}

// Construye la metaLine de fermentación según el estado del lote:
//   InFermentation: "Plan: 48h · Lleva: 12h" (color rojo si pasó)
//   Drying o más:   "Plan: 48h · Real: 52h"  (badge ámbar si > +10%)
function fermentationLineFor(l) {
  const plan = Number(l.fermentation_hours || 0);
  if (plan === 0 && l.status === 'InFermentation') return null;
  const ferm = l.fermentation_start_at;
  if (!ferm) {
    return plan > 0 ? metaLineRaw('Fermentación', `Plan: ${plan}h`) : null;
  }
  if (l.status === 'InFermentation') {
    const elapsed = hoursBetween(ferm, null);
    if (elapsed == null) return metaLineRaw('Fermentación', `Plan: ${plan}h`);
    const over = plan > 0 && elapsed > plan;
    const valueClass = over ? 'text-crit font-bold' : '';
    return metaLineRaw('Fermentación', `Plan: ${plan}h · Lleva: ${Math.round(elapsed)}h`, valueClass);
  }
  const real = hoursBetween(ferm, l.drying_start_at);
  if (real == null) return metaLineRaw('Fermentación', `Plan: ${plan}h`);
  const diff = plan > 0 ? Math.abs(real - plan) / plan : 0;
  const off = diff > 0.1;
  const valueClass = off ? 'text-warn font-semibold' : '';
  return metaLineRaw('Fermentación', `Plan: ${plan}h · Real: ${Math.round(real)}h`, valueClass);
}

function metaLineRaw(label, value, valueClass = '') {
  return el('div', { class: 'flex items-baseline gap-1.5' }, [
    el('span', { class: 'text-[9px] uppercase tracking-wide text-ink-300 w-24 shrink-0', text: label }),
    el('span', { class: `text-[12px] font-mono font-semibold ${valueClass || 'text-ink-700'}`, text: value }),
  ]);
}

function stageStartDate(lot) {
  if (lot.status === 'Resting')        return lot.resting_start_date;
  if (lot.status === 'Drying')         return lot.drying_start_date;
  if (lot.status === 'InFermentation') return lot.start_date;
  if (lot.status === 'Ready')          return lot.ready_date;
  return lot.start_date;
}

function urgencyLevel(days, limits) {
  if (days >= limits.crit) return 'crit';
  if (days >= limits.warn) return 'warn';
  return 'ok';
}

function progressPct(days, limits) {
  return Math.min(100, Math.round((days / limits.crit) * 100));
}

// ── Vista principal ────────────────────────────────────────────
export async function fincaTableroView() {
  // Cargamos TODOS los lotes (incluido Delivered) para el historial
  // de acciones del Tablero. El grid de cards filtra solo
  // InFermentation/Drying/Resting; el historial usa todo.
  const { lots: allLots } = await api.lotsList({});

  // Solo lotes en proceso (no Ready ni Delivered para el tablero principal,
  // pero Ready se incluye en el conteo y filtro).
  const IN_PROCESS = new Set(['InFermentation', 'Drying', 'Resting']);
  let lots = allLots.filter((l) => IN_PROCESS.has(l.status));
  let activeFilter = 'all';

  const root = el('div', { class: 'space-y-4' });
  const kpiStrip = el('div', { class: 'grid grid-cols-2 sm:grid-cols-4 gap-3' });
  const filtersRow = el('div', { class: 'flex flex-wrap gap-2 items-center' });
  const legendRow = el('div', { class: 'flex flex-wrap gap-4 text-[11px] text-ink-500 items-center' });
  const grid = el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3' });

  function countByStatus(status) {
    return allLots.filter((l) => l.status === status).length;
  }

  function renderKpi() {
    clear(kpiStrip);
    const stages = [
      { label: 'Total en proceso', count: lots.length, color: '#1b203d' },
      { label: 'Fermentación', count: countByStatus('InFermentation'), color: '#c62828' },
      { label: 'Secado', count: countByStatus('Drying'), color: '#e65100' },
      { label: 'Descanso', count: countByStatus('Resting'), color: '#2e7d32' },
    ];
    stages.forEach((s) => {
      kpiStrip.append(el('div', {
        class: 'bg-white border border-sand rounded-xl p-4 text-center',
        style: `border-top: 3px solid ${s.color}`,
      }, [
        el('div', { class: 'text-[10px] text-ink-500 uppercase tracking-eyebrow font-semibold', text: s.label }),
        el('div', { class: 'text-[28px] font-mono font-extrabold leading-tight', style: `color:${s.color}`, text: String(s.count) }),
      ]));
    });
  }

  function renderFilters() {
    clear(filtersRow);
    const filters = [
      { key: 'all', label: 'Todos', count: lots.length },
      { key: 'InFermentation', label: 'Fermentación', count: countByStatus('InFermentation') },
      { key: 'Drying', label: 'Secado', count: countByStatus('Drying') },
      { key: 'Resting', label: 'Descanso', count: countByStatus('Resting') },
    ];
    filters.forEach((f) => {
      const isActive = activeFilter === f.key;
      filtersRow.append(el('button', {
        class: `px-3 py-1.5 rounded-lg text-[12px] font-semibold border transition-all ${
          isActive
            ? 'bg-navy text-white border-navy'
            : 'bg-white text-ink-700 border-sand hover:border-navy'}`,
        onClick: () => { activeFilter = f.key; renderGrid(); renderFilters(); },
      }, [
        f.label,
        el('span', {
          class: `ml-1.5 inline-block px-1.5 rounded-full text-[10px] ${
            isActive ? 'bg-white/20 text-white' : 'bg-sand text-ink-500'}`,
          text: String(f.count),
        }),
      ]));
    });
  }

  function renderLegend() {
    clear(legendRow);
    legendRow.append(
      el('span', {}, [dot('ok'), ' Dentro de parámetros']),
      el('span', {}, [dot('warn'), ' Cerca al límite']),
      el('span', {}, [dot('crit'), ' Fuera de límite']),
      el('span', { class: 'ml-auto italic text-ink-300', text: 'Ordenado: más días en proceso primero' }),
    );
  }

  function renderGrid() {
    clear(grid);
    let filtered = activeFilter === 'all'
      ? lots
      : lots.filter((l) => l.status === activeFilter);

    // Ordenar por días en etapa actual (desc)
    filtered = filtered.slice().sort((a, b) => {
      const dA = daysSince(stageStartDate(a));
      const dB = daysSince(stageStartDate(b));
      return dB - dA;
    });

    if (filtered.length === 0) {
      grid.append(el('div', { class: 'col-span-full text-center py-8 text-ink-300 text-[13px]',
        text: activeFilter === 'all' ? 'No hay lotes en proceso' : `No hay lotes en ${activeFilter}` }));
      return;
    }
    filtered.forEach((l) => grid.append(lotCard(l)));
  }

  function lotCard(l) {
    const start = stageStartDate(l);
    const days = daysSince(start);
    const limits = getLimits(l.status, l.process_type);
    const level = urgencyLevel(days, limits);
    const pct = progressPct(days, limits);
    const transitions = NEXT_TRANSITIONS[l.status] || { primary: null, secondary: [] };

    const borderColor = level === 'crit' ? '#c62828' : level === 'warn' ? '#e65100' : '#2e7d32';
    const numberColor = level === 'crit' ? 'color:#c62828' : level === 'warn' ? 'color:#e65100' : 'color:#2e7d32';
    const barColor = level === 'crit' ? '#c62828' : level === 'warn' ? '#e65100' : '#2e7d32';

    const stageLabels = {
      InFermentation: 'fermentación',
      Drying: 'secado',
      Resting: 'descanso',
      Ready: 'listo',
    };
    const totalDays = l.start_date ? daysSince(l.start_date) : null;
    const locations = (l.status === 'Drying' && (l.drying_locations || []).length > 0)
      ? l.drying_locations.join(', ') : null;
    const etapaTxt = statusLabel(l.status) + (locations ? ` · ${locations}` : '');
    const humidity = (l.status === 'Resting' && l.resting_humidity != null) ? l.resting_humidity : null;

    const metaLine = (label, value) => el('div', { class: 'flex items-baseline gap-1.5' }, [
      el('span', { class: 'text-[9px] uppercase tracking-wide text-ink-300 w-24 shrink-0', text: label }),
      el('span', { class: 'text-[12px] font-mono text-ink-700 font-semibold', text: value }),
    ]);

    return el('div', {
      class: 'bg-white border border-sand rounded-xl p-4 hover:shadow-sm transition-shadow',
      style: `border-left: 4px solid ${borderColor}`,
    }, [
      // Stepper del proceso (Fermentación → Secado → Descanso → Listo)
      processStepper(l.status),
      // Fila superior: info (izquierda) + contador de días (derecha)
      el('div', { class: 'flex items-start justify-between gap-3 mb-3' }, [
        // ── Izquierda: info ──
        el('div', { class: 'flex-1 min-w-0' }, [
          // Código + referencia
          el('div', { class: 'flex items-center gap-2 flex-wrap mb-1.5' }, [
            l.parent_lot_id
              ? el('span', { class: 'ctrm-pill text-[9px]', style: 'background:#e0e7f5;color:#1b2044;', text: 'SUB' })
              : null,
            l.is_blend
              ? el('span', { class: 'ctrm-pill text-[9px]', style: 'background:#e8efe3;color:#2e4a2e;', text: 'MEZCLA' })
              : null,
            el('span', {
              class: 'font-mono font-bold text-[15px] text-navy cursor-pointer hover:underline',
              onClick: () => navigate(`/finca/bache?id=${l.id}`),
              text: l.bache_code || l.blend_code || l.lot_code,
            }),
            l.reference_name
              ? el('span', { class: 'font-display font-semibold text-[12px] text-ink-500', text: l.reference_name })
              : null,
          ]),
          // Pills: proceso + variedades
          el('div', { class: 'flex items-center gap-1.5 flex-wrap mb-2' }, [
            el('span', { class: 'ctrm-pill', style: 'background:#dde7ee;color:#1a3a5c;', text: l.process_type || '—' }),
            ...(l.varieties || []).map((v) =>
              el('span', { class: 'ctrm-pill dark text-[9px]', text: v.name })),
          ]),
          // Meta: kg, etapa+locación, humedad, días totales
          el('div', { class: 'space-y-0.5' }, [
            metaLine('Kg iniciales', `${fmtKg(l.kg_input_initial || 0)} kg`),
            metaLine('Etapa', etapaTxt),
            humidity != null ? metaLine('Humedad', `${humidity}%`) : null,
            // Horas de fermentación: muestra plan/lleva (en proceso)
            // o plan/real (cuando ya pasó a secado o más allá).
            fermentationLineFor(l),
            totalDays != null
              ? metaLine('Días totales', `${totalDays} ${totalDays === 1 ? 'día' : 'días'} · desde ${fmtDate(l.start_date)}`)
              : null,
          ]),
        ]),
        // ── Derecha: contador de días en la etapa ──
        el('div', { class: 'text-center shrink-0 w-20' }, [
          el('div', { class: 'font-mono font-extrabold text-[30px] leading-none', style: numberColor, text: String(days) }),
          el('div', { class: 'text-[9px] uppercase tracking-wide text-ink-500 mt-1 leading-tight',
            text: `${days === 1 ? 'día' : 'días'} en ${stageLabels[l.status] || l.status}` }),
        ]),
      ]),

      // Barra de progreso
      el('div', { class: 'h-1.5 rounded-full bg-sand mb-3 overflow-hidden' }, [
        el('div', { class: 'h-full rounded-full transition-all', style: `width:${pct}%;background:${barColor}` }),
      ]),

      // Acciones
      el('div', { class: 'flex flex-wrap gap-1.5' }, [
        transitions.primary
          ? el('button', {
              class: 'px-3 py-1.5 rounded-md text-[11px] font-semibold bg-navy text-white border border-navy hover:bg-navy/90 transition-all',
              onClick: () => doAdvance(l, transitions.primary.target),
            }, [transitions.primary.label])
          : null,
        ...(transitions.secondary || []).map((t) =>
          el('button', {
            class: 'px-3 py-1.5 rounded-md text-[11px] font-semibold bg-white text-ink-700 border border-sand hover:border-navy transition-all',
            onClick: () => doAdvance(l, t.target),
          }, [t.label])),
        ['InFermentation', 'Drying', 'Resting'].includes(l.status)
          ? el('button', {
              class: 'px-3 py-1.5 rounded-md text-[11px] font-semibold bg-white text-ink-700 border border-sand hover:border-navy transition-all',
              onClick: () => openSplitFromTablero(l),
            }, ['Dividir'])
          : null,
      ]),
    ]);
  }

  async function doAdvance(lot, target) {
    try {
      const r = await advanceStatusShared(lot, target);
      if (r === null) return;
      toast(`${lot.bache_code || lot.lot_code} → ${statusLabel(target)}`, 'success');
      if (r && r.completions && r.completions.length > 0) {
        toast(`${r.completions.length} pedido(s) completado(s)`, 'success', 4500);
      }
      await reload();
    } catch (e) {
      toast(e.message || 'Error en el cambio de estado', 'error', 6000);
    }
  }

  async function openSplitFromTablero(lot) {
    const { openModal } = await import('../ui/modal.js');
    const kgBase = Number(lot.kg_input_initial || 0);
    if (kgBase <= 0) { toast('El bache no tiene kg registrado', 'warning'); return; }

    const result = await openModal(({ close }) => {
      const pInput = el('input', {
        type: 'number', step: '1', min: '1', max: '99',
        class: 'ctrm-input mono text-center w-20',
        placeholder: '1',
      });
      const kgInput = el('input', {
        type: 'number', step: '0.01', min: '0.01', max: String(kgBase - 0.01),
        class: 'ctrm-input mono text-right w-full',
        placeholder: `Máx ${fmtKg(kgBase - 0.01)}`,
      });
      return el('div', { class: 'space-y-3' }, [
        el('div', { class: 'rounded-lg bg-cream border border-sand p-3' }, [
          el('p', { class: 'text-[12px] text-ink-700' }, [
            `Bache `, el('strong', { class: 'text-navy', text: lot.bache_code || lot.lot_code }),
            ` — `, el('strong', { text: fmtKg(kgBase) }), ` kg`,
          ]),
        ]),
        el('div', { class: 'grid grid-cols-2 gap-3' }, [
          el('div', {}, [
            el('label', { class: 'ctrm-label', text: 'Número (P___)' }),
            el('div', { class: 'flex items-center gap-1' }, [
              el('span', { class: 'font-mono font-bold text-navy text-[14px]', text: 'P' }),
              pInput,
            ]),
          ]),
          el('div', {}, [el('label', { class: 'ctrm-label', text: 'kg a separar' }), kgInput]),
        ]),
        el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
          el('button', { class: 'ctrm-btn ctrm-btn-ghost', onClick: () => close(null) }, ['Cancelar']),
          el('button', { class: 'ctrm-btn ctrm-btn-primary', onClick: async () => {
            const pNum = Number(pInput.value);
            if (!Number.isFinite(pNum) || pNum < 1 || pNum > 99 || pNum !== Math.floor(pNum)) {
              toast('Indica un P entre 1 y 99', 'warning'); return;
            }
            const kg = Number(kgInput.value);
            if (!Number.isFinite(kg) || kg <= 0 || kg >= kgBase) { toast('kg inválido', 'warning'); return; }
            try {
              const r = await api.lotSplit({ production_lot_id: lot.id, sub_number: pNum, kg_to_split: kg });
              close({ ok: true, child: r.child });
            } catch (e) { toast(e.message, 'error'); }
          } }, ['Dividir']),
        ]),
      ]);
    }, { title: `Dividir ${lot.bache_code || lot.lot_code}` });

    if (result && result.ok) {
      toast(`Sub-bache ${result.child?.bache_code || ''} creado`, 'success');
      await reload();
    }
  }

  async function reload() {
    const { lots: fresh } = await api.lotsList({});
    lots = fresh.filter((l) => IN_PROCESS.has(l.status));
    renderKpi();
    renderFilters();
    renderGrid();
  }

  // Render inicial
  renderKpi();
  renderFilters();
  renderLegend();
  renderGrid();

  // ── Historial de acciones ─────────────────────────────────────
  const historyEl = el('section', { class: 'mt-6' });
  let historyRange = '7';  // '1' | '7' | '30' | 'all'
  function renderHistory() {
    clear(historyEl);
    const events = buildActionLog(allLots);
    const cutoff = (() => {
      if (historyRange === 'all') return null;
      const d = new Date();
      d.setDate(d.getDate() - Number(historyRange) + 1);
      return d.toISOString().slice(0, 10);
    })();
    const filtered = cutoff ? events.filter((e) => e.date >= cutoff) : events;
    const rangeSel = el('select', {
      class: 'ctrm-input text-[12px]',
      onChange: (e) => { historyRange = e.target.value; renderHistory(); },
    }, [
      el('option', { value: '1',   selected: historyRange === '1'   ? 'true' : null }, ['Hoy']),
      el('option', { value: '7',   selected: historyRange === '7'   ? 'true' : null }, ['Últimos 7 días']),
      el('option', { value: '30',  selected: historyRange === '30'  ? 'true' : null }, ['Últimos 30 días']),
      el('option', { value: 'all', selected: historyRange === 'all' ? 'true' : null }, ['Todo el historial']),
    ]);
    const header = el('div', { class: 'flex items-center justify-between gap-3 mb-3 flex-wrap' }, [
      el('div', {}, [
        el('h3', { class: 'font-display text-[15px] text-navy font-semibold', text: 'Historial de acciones' }),
        el('p', { class: 'text-[11px] text-ink-500', text: `${filtered.length} acción(es)` }),
      ]),
      el('div', { class: 'flex items-center gap-2' }, [
        el('label', { class: 'text-[11px] text-ink-500', text: 'Rango:' }),
        rangeSel,
      ]),
    ]);
    historyEl.append(header);
    if (filtered.length === 0) {
      historyEl.append(el('div', { class: 'text-center text-[12px] text-ink-300 py-6 border border-sand rounded-lg',
        text: 'No hay acciones registradas en el rango seleccionado.' }));
      return;
    }
    historyEl.append(renderActionTable(filtered));
  }
  renderHistory();

  root.prepend(legendRow);
  root.prepend(filtersRow);
  root.prepend(kpiStrip);
  root.prepend(pageTitle('Tablero de Control', 'Vista operativa · lotes en proceso por etapa'));
  root.append(grid);
  root.append(historyEl);
  return chrome(root);
}

// ── Action log builder ───────────────────────────────────────────
// Reconstruye los eventos por lote a partir de los timestamps
// (start_date, drying_start_date, ready_date, delivered_date),
// los ciclos de descanso y las relaciones de mezcla/split.
// Devuelve los eventos ordenados por fecha DESC.
function buildActionLog(allLots) {
  const events = [];
  const lotById = new Map(allLots.map((l) => [l.id, l]));
  const codeOf = (l) => l.bache_code || l.blend_code || l.lot_code || '?';

  for (const l of allLots) {
    const code = codeOf(l);

    if (l.start_date) {
      events.push({
        date: l.start_date, lot_id: l.id, bache: code,
        action: 'Bache creado',
        from: '—', to: 'Fermentación',
        humidity: null, kg: l.kg_input_initial,
        detail: stageLabel(l.processing_stage),
      });
    }

    if (l.drying_start_date) {
      events.push({
        date: l.drying_start_date, lot_id: l.id, bache: code,
        action: '→ Secado',
        from: 'Fermentación', to: 'Secado',
        humidity: null, kg: null,
        detail: (l.drying_locations || []).join(', ') || '—',
      });
    }

    const cycles = (l.resting_cycles || []).slice().sort((a, b) => a.cycle_number - b.cycle_number);
    for (const c of cycles) {
      events.push({
        date: c.start_date, lot_id: l.id, bache: code,
        action: `→ Descanso (ciclo ${c.cycle_number})`,
        from: 'Secado', to: 'Descanso',
        humidity: c.start_humidity, kg: null, detail: '',
      });
      if (c.end_date) {
        const back = c.end_reason === 'back_to_drying';
        events.push({
          date: c.end_date, lot_id: l.id, bache: code,
          action: back ? '← Volver a Secado' : '→ Listo',
          from: 'Descanso', to: back ? 'Secado' : 'Listo',
          humidity: c.end_humidity,
          kg: !back ? l.kg_dried_output : null,
          detail: !back && l.factor_rendimiento ? `Factor ${l.factor_rendimiento}` : '',
        });
      }
    }

    const lastCycle = cycles[cycles.length - 1];
    const readyFromRest = lastCycle && lastCycle.end_reason === 'to_ready' && lastCycle.end_date === l.ready_date;
    if (l.ready_date && !readyFromRest) {
      events.push({
        date: l.ready_date, lot_id: l.id, bache: code,
        action: '→ Listo',
        from: 'Secado', to: 'Listo',
        humidity: l.final_humidity,
        kg: l.kg_dried_output,
        detail: l.factor_rendimiento ? `Factor ${l.factor_rendimiento}` : '',
      });
    }

    if (l.delivered_date) {
      events.push({
        date: l.delivered_date, lot_id: l.id, bache: code,
        action: '→ Despachado',
        from: 'Listo', to: 'Despachado',
        humidity: null, kg: null, detail: '',
      });
    }

    // Sub-bache (split)
    if (l.parent_lot_id) {
      const parent = lotById.get(l.parent_lot_id);
      const parentCode = parent ? codeOf(parent) : '?';
      const created = l.created_at ? l.created_at.slice(0, 10) : l.start_date;
      events.push({
        date: created, lot_id: l.id, bache: code,
        action: 'Sub-bache creado',
        from: parentCode, to: code,
        humidity: null, kg: l.kg_input_initial,
        detail: `Dividido de ${parentCode}`,
      });
    }

    // Mezcla creada
    if (l.is_blend) {
      const sources = (l.blend_components || [])
        .map((c) => c.bache_code || c.blend_code || c.lot_code).join(' + ');
      const created = l.created_at ? l.created_at.slice(0, 10) : l.start_date;
      events.push({
        date: created, lot_id: l.id, bache: code,
        action: 'Mezcla creada',
        from: sources || '?', to: code,
        humidity: null, kg: l.kg_dried_output,
        detail: '',
      });
    }
  }

  return events.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function stageLabel(s) {
  if (s === 'cereza')     return 'Cereza fresca';
  if (s === 'despulpado') return 'Despulpado';
  if (s === 'seco')       return 'Café seco';
  return s || '—';
}

function renderActionTable(events) {
  // Group events by date for the visual day separator. Within a date,
  // mantenemos el orden con el que vienen (ya viene DESC por fecha).
  const wrap = el('div', { class: 'overflow-x-auto border border-sand rounded-lg' });
  const tbody = el('tbody', {});
  let lastDate = null;
  for (const ev of events) {
    if (ev.date !== lastDate) {
      tbody.append(el('tr', { class: 'bg-cream' }, [
        el('td', { colspan: '7', class: 'px-3 py-1.5 text-[10px] uppercase tracking-eyebrow font-semibold text-ink-500',
          text: ev.date ? fmtDate(ev.date) : '—' }),
      ]));
      lastDate = ev.date;
    }
    tbody.append(el('tr', { class: 'border-t border-sand hover:bg-cream/40' }, [
      el('td', { class: 'px-3 py-2 text-[11px] text-ink-500 font-mono whitespace-nowrap', text: ev.date ? fmtDate(ev.date) : '—' }),
      el('td', { class: 'px-3 py-2 font-mono text-[12px] font-semibold text-navy cursor-pointer hover:underline',
        title: 'Ver detalle del bache',
        onClick: () => navigate(`/finca/bache?id=${ev.lot_id}`),
        text: ev.bache }),
      el('td', { class: 'px-3 py-2 text-[12px] text-navy font-semibold', text: ev.action }),
      el('td', { class: 'px-3 py-2 text-[11px] text-ink-500',
        text: `${ev.from} → ${ev.to}` }),
      el('td', { class: 'px-3 py-2 text-right font-mono text-[11px]',
        text: ev.humidity != null ? `${ev.humidity}%` : '—' }),
      el('td', { class: 'px-3 py-2 text-right font-mono text-[11px] text-ink-700',
        text: ev.kg != null ? fmtKg(ev.kg) : '—' }),
      el('td', { class: 'px-3 py-2 text-[11px] text-ink-500', text: ev.detail || '' }),
    ]));
  }
  const table = el('table', { class: 'w-full text-[12px]' }, [
    el('thead', {}, [el('tr', { class: 'bg-navy text-yellow' }, [
      el('th', { class: 'px-3 py-2 text-left uppercase tracking-eyebrow text-[10px]', text: 'Fecha' }),
      el('th', { class: 'px-3 py-2 text-left uppercase tracking-eyebrow text-[10px]', text: 'Bache' }),
      el('th', { class: 'px-3 py-2 text-left uppercase tracking-eyebrow text-[10px]', text: 'Acción' }),
      el('th', { class: 'px-3 py-2 text-left uppercase tracking-eyebrow text-[10px]', text: 'Etapa' }),
      el('th', { class: 'px-3 py-2 text-right uppercase tracking-eyebrow text-[10px]', text: 'Humedad' }),
      el('th', { class: 'px-3 py-2 text-right uppercase tracking-eyebrow text-[10px]', text: 'Kg' }),
      el('th', { class: 'px-3 py-2 text-left uppercase tracking-eyebrow text-[10px]', text: 'Detalle' }),
    ])]),
    tbody,
  ]);
  wrap.append(table);
  return wrap;
}

// ── helpers ────────────────────────────────────────────────────
function dot(level) {
  const colors = { ok: '#2e7d32', warn: '#e65100', crit: '#c62828' };
  return el('span', {
    style: `display:inline-block;width:10px;height:10px;border-radius:50%;background:${colors[level] || '#ccc'};vertical-align:middle;margin-right:4px`,
  });
}
