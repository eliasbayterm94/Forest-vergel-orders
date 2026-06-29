// /finca/analytics — tablero analítico para el Vergel.
//
// Filtros (todos opt-in, top del tablero):
//   · Período (start_date del bache): 30d / 90d / año / personalizado
//   · Bache (single + autocomplete) → si se elige uno, aparece el
//     bloque "Timeline del lote" abajo y los KPI/charts se filtran
//     a ese bache solamente.
//   · Variedad (any-match)
//   · Proceso (Natural / Honey / Lavado)
//
// KPIs (4):
//   · En proceso (lotes + kg)
//   · Tiempo promedio entrada → Listo (días, solo Ready/Delivered)
//   · Rotación promedio entrada → despacho, ponderada por kg seco
//   · Kg activos hoy en secado (suma físicamente en bodega de secado)
//
// Charts:
//   · Pie: kg cereza ingresada por proceso
//   · Bars agrupadas: kg cereza vs kg seco por mes
//   · Bars horizontales: kg activos por equipo de secado
//     (los baches en Descanso se agregan como un "equipo" aparte)

import { el, clear } from '../ui/el.js';
import { fmtKg, fmtDate, statusLabel } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { pieChart, groupedBarChart, horizontalBarChart } from '../ui/charts.js';
import { createCombobox } from '../ui/combobox.js';

const PROCESS_COLORS = {
  Natural: '#3a6f4a',
  Honey:   '#ddae3e',
  Lavado:  '#7e9ec1',
};

const ACTIVE_STATUSES = new Set(['InFermentation', 'Drying', 'Resting']);

export async function fincaAnalyticsView() {
  const [lotsRes, shipsRes, varsRes, dryRes] = await Promise.all([
    api.lotsList({}),                       // todos incluyendo Delivered
    api.shipmentsList(),
    api.varieties(),
    api.dryingTypesList({}).catch(() => ({ drying_types: [] })),
  ]);
  const allLots = lotsRes.lots || [];
  const today = lotsRes.today || new Date().toISOString().slice(0, 10);
  const shipments = shipsRes.shipments || [];
  const allVarieties = varsRes.varieties || [];

  // Despachos por lot_id (para Rotación: entrada → despacho)
  const earliestShipByLot = new Map();
  for (const s of shipments) {
    for (const lot of s.lots || []) {
      const cur = earliestShipByLot.get(lot.id);
      const d = s.shipment_date;
      if (!cur || (d && d < cur)) earliestShipByLot.set(lot.id, d);
    }
  }

  // ── Estado del filtro ─────────────────────────────────────
  const state = {
    period: '90',          // '30' | '90' | '365' | 'all'
    bacheId: null,         // uuid o null
    variety: '',           // variety id o ''
    process: '',           // '' | 'Natural' | 'Honey' | 'Lavado'
  };

  function applyFilters(lots) {
    let limit = null;
    if (state.period !== 'all') {
      const days = Number(state.period);
      const from = new Date(today + 'T00:00:00Z').getTime() - days * 86400000;
      limit = new Date(from).toISOString().slice(0, 10);
    }
    return lots.filter((l) => {
      if (limit && l.start_date && l.start_date < limit) return false;
      if (state.bacheId && l.id !== state.bacheId) return false;
      if (state.variety) {
        const vids = (l.varieties || []).map((v) => v.id);
        if (!vids.includes(state.variety)) return false;
      }
      if (state.process && l.process_type !== state.process) return false;
      return true;
    });
  }

  const root = el('div', {});

  function redraw() {
    clear(root);
    const filtered = applyFilters(allLots);

    // ── Métricas ──────────────────────────────────────────
    const inProcessLots = filtered.filter((l) => ACTIVE_STATUSES.has(l.status));
    const inProcessKg = inProcessLots.reduce((s, l) =>
      s + Number(l.kg_input_initial ?? l.kg_cherry_input ?? 0), 0);

    const closed = filtered.filter((l) => l.start_date && l.ready_date);
    const timeAvg = closed.length > 0
      ? closed.reduce((s, l) => s + daysBetween(l.start_date, l.ready_date), 0) / closed.length
      : null;
    const timeMedian = closed.length > 0 ? median(closed.map((l) => daysBetween(l.start_date, l.ready_date))) : null;

    // Rotación: entrada → despacho, ponderada por kg seco
    const rotated = filtered
      .filter((l) => l.start_date && earliestShipByLot.get(l.id))
      .map((l) => ({
        days: daysBetween(l.start_date, earliestShipByLot.get(l.id)),
        kg: Number(l.kg_dried_output || 0),
      }))
      .filter((x) => x.kg > 0);
    const rotWeighted = (() => {
      const totalKg = rotated.reduce((s, x) => s + x.kg, 0);
      if (totalKg <= 0) return null;
      const sumDxKg = rotated.reduce((s, x) => s + x.days * x.kg, 0);
      return sumDxKg / totalKg;
    })();
    const rotStd = rotWeighted != null && rotated.length > 1
      ? Math.sqrt(rotated.reduce((s, x) => s + x.kg * Math.pow(x.days - rotWeighted, 2), 0) / rotated.reduce((s, x) => s + x.kg, 0))
      : null;

    // Kg activos en secado: suma kg_input_initial (o cherry) de baches
    // que físicamente están en Drying o Resting hoy.
    const dryingActive = filtered.filter((l) => l.status === 'Drying' || l.status === 'Resting');
    const dryingActiveKg = dryingActive.reduce((s, l) =>
      s + Number(l.kg_input_initial ?? l.kg_cherry_input ?? 0), 0);

    root.append(filtersRow());

    root.append(kpiRow([
      kpiCard('En proceso', `${inProcessLots.length} lotes`,
        `${fmtKg(inProcessKg)} kg cereza activa`),
      kpiCard('Tiempo prom. (a Listo)', timeAvg != null ? `${roundN(timeAvg, 1)} días` : '—',
        timeMedian != null ? `mediana ${roundN(timeMedian, 1)} d · ${closed.length} cerrados` : 'sin baches cerrados'),
      kpiCard('Rotación (a Despacho)', rotWeighted != null ? `${roundN(rotWeighted, 1)} días` : '—',
        rotStd != null ? `pond. kg seco · σ ${roundN(rotStd, 1)} d` : 'sin despachos'),
      kpiCard('Activo en secado hoy', fmtKg(dryingActiveKg),
        `${dryingActive.length} lotes (Secado + Descanso)`),
    ]));

    // ── Charts: pie por proceso + barras mensual ─────────
    root.append(el('div', { class: 'grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3' }, [
      chartCard('Cereza por proceso', renderProcessPie(filtered)),
      chartCard('Entrada vs Seco por mes', renderMonthlyBars(filtered)),
    ]));

    // ── Distribución por equipo de secado ───────────────
    root.append(chartCard('Kg activos por equipo de secado',
      renderDryingDistribution(filtered),
      'Suma kg cereza inicial de baches en Drying agrupados por marquesina/equipo. "Descanso" agrupa los lotes en Resting.'));

    // ── Timeline del bache (solo si hay 1 seleccionado) ──
    if (state.bacheId) {
      const lot = allLots.find((l) => l.id === state.bacheId);
      if (lot) root.append(renderLotTimeline(lot, earliestShipByLot.get(lot.id)));
    }
  }

  function filtersRow() {
    const periodBtns = ['30', '90', '365', 'all'].map((p) => el('button', {
      type: 'button',
      class: p === state.period ? 'ctrm-btn ctrm-btn-primary ctrm-btn-xs' : 'ctrm-btn ctrm-btn-soft ctrm-btn-xs',
      onClick: () => { state.period = p; redraw(); },
    }, [p === 'all' ? 'Todo' : p === '365' ? '1 año' : `${p}d`]));

    const procSel = el('select', {
      class: 'ctrm-input text-[12px]',
      onChange: (e) => { state.process = e.target.value; redraw(); },
    }, [
      el('option', { value: '', selected: state.process === '' }, ['Todos los procesos']),
      ...['Natural', 'Honey', 'Lavado'].map((p) =>
        el('option', { value: p, selected: state.process === p }, [p])),
    ]);

    const varSel = el('select', {
      class: 'ctrm-input text-[12px]',
      onChange: (e) => { state.variety = e.target.value; redraw(); },
    }, [
      el('option', { value: '', selected: state.variety === '' }, ['Todas las variedades']),
      ...allVarieties.map((v) =>
        el('option', { value: v.id, selected: state.variety === v.id }, [v.name])),
    ]);

    // Bache combobox (single)
    const bacheOptions = allLots.map((l) => ({
      id: l.id,
      name: `${l.bache_code || l.lot_code} · ${l.process_type} · ${statusLabel(l.status)}`,
    }));
    const initialBache = state.bacheId
      ? bacheOptions.find((b) => b.id === state.bacheId) || null
      : null;
    const bacheCombo = createCombobox({
      placeholder: 'Buscar bache…',
      items: bacheOptions,
      initialValue: initialBache,
      onChange: (item) => { state.bacheId = item ? item.id : null; redraw(); },
    });

    const clearBtn = (state.period !== '90' || state.bacheId || state.variety || state.process)
      ? el('button', {
          type: 'button',
          class: 'ctrm-btn ctrm-btn-ghost ctrm-btn-xs',
          onClick: () => {
            state.period = '90'; state.bacheId = null; state.variety = ''; state.process = '';
            redraw();
          },
        }, ['Limpiar todo'])
      : null;

    return el('div', { class: 'ctrm-card ctrm-card-pad mb-3' }, [
      el('div', { class: 'flex flex-wrap items-end gap-3' }, [
        el('div', { class: 'flex flex-col gap-1' }, [
          el('span', { class: 'eyebrow text-[10px]', text: 'Período (start_date)' }),
          el('div', { class: 'flex flex-wrap gap-1' }, periodBtns),
        ]),
        el('div', { class: 'flex flex-col gap-1 min-w-[200px] flex-1' }, [
          el('span', { class: 'eyebrow text-[10px]', text: 'Bache' }),
          bacheCombo.el,
        ]),
        el('div', { class: 'flex flex-col gap-1 min-w-[160px]' }, [
          el('span', { class: 'eyebrow text-[10px]', text: 'Variedad' }),
          varSel,
        ]),
        el('div', { class: 'flex flex-col gap-1 min-w-[160px]' }, [
          el('span', { class: 'eyebrow text-[10px]', text: 'Proceso' }),
          procSel,
        ]),
        clearBtn,
      ]),
    ]);
  }

  function renderProcessPie(lots) {
    const sumBy = { Natural: 0, Honey: 0, Lavado: 0 };
    for (const l of lots) {
      const kg = Number(l.kg_input_initial ?? l.kg_cherry_input ?? 0);
      if (sumBy[l.process_type] != null) sumBy[l.process_type] += kg;
    }
    const slices = ['Natural', 'Honey', 'Lavado'].map((p) => ({
      label: p,
      value: sumBy[p],
      color: PROCESS_COLORS[p],
    }));
    return pieChart(slices, { unit: 'kg cereza' });
  }

  function renderMonthlyBars(lots) {
    // Agregamos por YYYY-MM del start_date
    const byMonth = new Map();
    for (const l of lots) {
      if (!l.start_date) continue;
      const key = l.start_date.slice(0, 7);
      if (!byMonth.has(key)) byMonth.set(key, { cereza: 0, seco: 0 });
      const m = byMonth.get(key);
      m.cereza += Number(l.kg_input_initial ?? l.kg_cherry_input ?? 0);
      m.seco   += Number(l.kg_dried_output ?? 0);
    }
    const keys = [...byMonth.keys()].sort();
    if (keys.length === 0) {
      return el('p', { class: 'text-[12px] text-ink-300 italic text-center py-6',
        text: 'Sin baches en el rango seleccionado.' });
    }
    const labels = keys.map((k) => formatMonth(k));
    const cerezaSeries = keys.map((k) => byMonth.get(k).cereza);
    const secoSeries = keys.map((k) => byMonth.get(k).seco);
    return groupedBarChart(labels, [
      { label: 'kg cereza', color: '#a8351c', values: cerezaSeries },
      { label: 'kg seco',   color: '#ddae3e', values: secoSeries },
    ]);
  }

  function renderDryingDistribution(lots) {
    // Equipos físicos: agrupar por cada drying_location
    const byEquipo = new Map();   // equipo → { kg, lots }
    const inResting = { kg: 0, lots: 0 };
    for (const l of lots) {
      const kg = Number(l.kg_input_initial ?? l.kg_cherry_input ?? 0);
      if (l.status === 'Drying') {
        const locations = (l.drying_locations || []);
        if (locations.length === 0) {
          const cur = byEquipo.get('(sin equipo)') || { kg: 0, lots: 0 };
          cur.kg += kg; cur.lots += 1;
          byEquipo.set('(sin equipo)', cur);
        } else {
          // Si tiene varias, prorratea por igual entre ellas para no doblar el total
          const share = kg / locations.length;
          for (const loc of locations) {
            const cur = byEquipo.get(loc) || { kg: 0, lots: 0 };
            cur.kg += share; cur.lots += 1 / locations.length;
            byEquipo.set(loc, cur);
          }
        }
      } else if (l.status === 'Resting') {
        inResting.kg += kg;
        inResting.lots += 1;
      }
    }
    const bars = [...byEquipo.entries()]
      .sort((a, b) => b[1].kg - a[1].kg)
      .map(([name, v]) => ({
        label: name,
        value: v.kg,
        sublabel: `${Math.round(v.lots)} ${Math.round(v.lots) === 1 ? 'lote' : 'lotes'}`,
        color: '#ddae3e',
      }));
    if (inResting.kg > 0) {
      bars.push({
        label: 'Descanso',
        value: inResting.kg,
        sublabel: `${inResting.lots} ${inResting.lots === 1 ? 'lote' : 'lotes'}`,
        color: '#7e9ec1',
      });
    }
    if (bars.length === 0) {
      return el('p', { class: 'text-[12px] text-ink-300 italic text-center py-6',
        text: 'Sin baches en Secado o Descanso ahora mismo.' });
    }
    return horizontalBarChart(bars);
  }

  function renderLotTimeline(lot, shipDate) {
    const events = [];
    if (lot.start_date) events.push({
      ts: lot.start_date, label: 'Fermentación iniciada',
      detail: `${(lot.fermentation_types || []).join(' · ') || '—'}${(lot.fermentation_tanks || []).length ? ' · Tanques ' + lot.fermentation_tanks.join(', ') : ''}`,
      color: '#7a8a57',
    });
    if (lot.drying_start_date) events.push({
      ts: lot.drying_start_date, label: '→ Secado',
      detail: (lot.drying_locations || []).length > 0 ? `Equipo: ${lot.drying_locations.join(' · ')}` : '—',
      color: '#ddae3e',
    });
    for (const c of (lot.resting_cycles || []).sort((a, b) => a.cycle_number - b.cycle_number)) {
      events.push({
        ts: c.start_date, label: `→ Descanso · ciclo ${c.cycle_number}`,
        detail: `entrada ${c.start_humidity}%`,
        color: '#7e9ec1',
      });
      if (c.end_date) {
        const back = c.end_reason === 'back_to_drying';
        events.push({
          ts: c.end_date,
          label: back ? '← Volver a Secado' : '→ Listo (desde descanso)',
          detail: `salida ${c.end_humidity != null ? c.end_humidity + '%' : '—'}${back && (c.drying_locations_after || []).length ? ' · Equipo: ' + c.drying_locations_after.join(' · ') : ''}`,
          color: back ? '#ddae3e' : '#5d8b66',
        });
      }
    }
    if (lot.ready_date) events.push({
      ts: lot.ready_date, label: '→ Listo',
      detail: `${lot.kg_dried_output != null ? fmtKg(lot.kg_dried_output) + ' seco' : '—'}${lot.factor_rendimiento != null ? ' · factor ' + lot.factor_rendimiento : ''}`,
      color: '#5d8b66',
    });
    if (lot.delivered_date) events.push({
      ts: lot.delivered_date, label: '→ Despachado',
      detail: shipDate ? `el ${fmtDate(shipDate)}` : '',
      color: '#1b203d',
    });
    events.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));

    const totalDays = lot.ready_date && lot.start_date
      ? daysBetween(lot.start_date, lot.ready_date)
      : null;
    const rotDays = lot.start_date && shipDate
      ? daysBetween(lot.start_date, shipDate)
      : null;

    return el('div', { class: 'ctrm-card overflow-hidden mb-3' }, [
      el('div', { class: 'px-3 py-2 bg-cream border-b border-sand flex flex-wrap items-baseline justify-between gap-2' }, [
        el('p', { class: 'eyebrow text-[10px]' }, [`Timeline de ${lot.bache_code || lot.lot_code}`]),
        el('p', { class: 'text-[11px] text-ink-500 font-mono' }, [
          lot.reference_name ? `${lot.reference_name} · ` : '',
          lot.process_type,
          totalDays != null ? ` · ${totalDays} d hasta Listo` : '',
          rotDays != null ? ` · ${rotDays} d hasta despacho` : '',
        ]),
      ]),
      el('div', { class: 'p-3 space-y-3' }, events.map((ev, i) => {
        const isLast = i === events.length - 1;
        return el('div', { class: 'flex gap-3' }, [
          el('div', { class: 'flex flex-col items-center shrink-0' }, [
            el('span', { class: 'inline-block w-2.5 h-2.5 rounded-full',
              style: `background:${ev.color};` }),
            !isLast ? el('span', { class: 'flex-1 w-px bg-sand mt-1', style: 'min-height:18px;' }) : null,
          ]),
          el('div', { class: 'flex-1 min-w-0 pb-1' }, [
            el('div', { class: 'flex items-baseline justify-between gap-2 flex-wrap' }, [
              el('span', { class: 'font-display text-[13px] text-navy font-semibold', text: ev.label }),
              el('span', { class: 'font-mono text-[11px] text-ink-500', text: ev.ts ? fmtDate(ev.ts) : '—' }),
            ]),
            ev.detail ? el('p', { class: 'text-[11px] text-ink-500 mt-0.5', text: ev.detail }) : null,
          ]),
        ]);
      })),
    ]);
  }

  redraw();

  return chrome(el('div', {}, [
    pageTitle('Analytics · El Vergel', `Hoy: ${today}`),
    root,
  ]));
}

// ─── Helpers ───────────────────────────────────────────────────
function kpiRow(cards) {
  return el('div', { class: 'grid grid-cols-2 lg:grid-cols-4 gap-2 mb-3' }, cards);
}
function kpiCard(label, value, hint) {
  return el('div', { class: 'stat-card' }, [
    el('p', { class: 'stat-label', text: label }),
    el('p', { class: 'stat-val', text: String(value) }),
    el('p', { class: 'stat-sub', text: hint || '' }),
  ]);
}
function chartCard(title, body, hint) {
  return el('div', { class: 'ctrm-card overflow-hidden mb-3' }, [
    el('div', { class: 'px-3 py-2 bg-cream border-b border-sand flex items-baseline justify-between gap-2' }, [
      el('p', { class: 'eyebrow text-[10px]', text: title }),
      hint ? el('p', { class: 'text-[10px] text-ink-300 italic max-w-[60%] text-right', text: hint }) : null,
    ]),
    el('div', { class: 'p-3' }, [body]),
  ]);
}
function daysBetween(fromYmd, toYmd) {
  if (!fromYmd || !toYmd) return 0;
  const a = new Date(fromYmd + 'T00:00:00Z').getTime();
  const b = new Date(toYmd   + 'T00:00:00Z').getTime();
  return Math.max(0, Math.floor((b - a) / 86400000));
}
function median(arr) {
  if (!arr || arr.length === 0) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function roundN(n, decimals) {
  const k = Math.pow(10, decimals);
  return Math.round(n * k) / k;
}
function formatMonth(yyyymm) {
  if (!yyyymm) return '—';
  const [y, m] = yyyymm.split('-').map(Number);
  const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  return `${months[m - 1]} ${String(y).slice(2)}`;
}
