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
  const { lots: allLots } = await api.lotsList({ active_only: 'true' });

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
            l.fermentation_hours && l.status === 'InFermentation'
              ? metaLine('Fermentación', `${l.fermentation_hours} h`) : null,
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
    const { lots: fresh } = await api.lotsList({ active_only: 'true' });
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

  root.prepend(legendRow);
  root.prepend(filtersRow);
  root.prepend(kpiStrip);
  root.prepend(pageTitle('Tablero de Control', 'Vista operativa · lotes en proceso por etapa'));
  root.append(grid);
  return chrome(root);
}

// ── helpers ────────────────────────────────────────────────────
function dot(level) {
  const colors = { ok: '#2e7d32', warn: '#e65100', crit: '#c62828' };
  return el('span', {
    style: `display:inline-block;width:10px;height:10px;border-radius:50%;background:${colors[level] || '#ccc'};vertical-align:middle;margin-right:4px`,
  });
}
