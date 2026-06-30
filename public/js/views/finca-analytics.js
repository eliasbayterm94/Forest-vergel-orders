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
import { navigate } from '../router.js';

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
    datePreset: 'last_12',  // 'this_month' | 'last_month' | 'this_quarter' | 'last_quarter' | 'this_year' | 'last_12' | 'custom'
    customFrom: '',         // YYYY-MM-DD si datePreset='custom'
    customTo:   '',
    bacheId: null,          // uuid o null
    variety: '',            // variety id o ''
    process: '',            // '' | 'Natural' | 'Honey' | 'Lavado'
  };

  // Devuelve { from, to } del rango activo (YYYY-MM-DD).
  function activeRange() {
    if (state.datePreset === 'custom') {
      return { from: state.customFrom || null, to: state.customTo || null };
    }
    return computeDateRange(state.datePreset, today);
  }

  function applyFilters(lots, opts = {}) {
    const range = opts.range !== false ? activeRange() : null;
    const dateField = opts.dateField || 'start_date';
    return lots.filter((l) => {
      const d = l[dateField] || (dateField === 'ship_date' ? earliestShipByLot.get(l.id) : null);
      if (range && range.from && d && d < range.from) return false;
      if (range && range.to   && d && d > range.to)   return false;
      if (range && (range.from || range.to) && !d) return false;
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
    // "filtered" = filtros de variedad/proceso/bache pero TODO el
    // tiempo. Cada KPI/chart aplica luego su filtro temporal sobre
    // el campo de fecha que corresponde (entrada, cierre o
    // despacho), porque un mismo "este mes" significa cosas
    // distintas según la métrica.
    const filteredAll = applyFilters(allLots, { range: false });

    // En proceso / Activo en secado: snapshot HOY (sin filtro
    // temporal — no tiene sentido limitar "lo que está en
    // fermentación ahora" a un rango pasado).
    const inProcessLots = filteredAll.filter((l) => ACTIVE_STATUSES.has(l.status));
    const inProcessKg = inProcessLots.reduce((s, l) =>
      s + Number(l.kg_input_initial ?? l.kg_cherry_input ?? 0), 0);
    const dryingActive = filteredAll.filter((l) => l.status === 'Drying' || l.status === 'Resting');
    const dryingActiveKg = dryingActive.reduce((s, l) =>
      s + Number(l.kg_input_initial ?? l.kg_cherry_input ?? 0), 0);

    // Tiempo prom. (a Listo): baches que CERRARON en el rango.
    const closedInRange = applyFilters(allLots, { dateField: 'ready_date' })
      .filter((l) => l.start_date && l.ready_date);
    const timeAvg = closedInRange.length > 0
      ? closedInRange.reduce((s, l) => s + daysBetween(l.start_date, l.ready_date), 0) / closedInRange.length
      : null;
    const timeMedian = closedInRange.length > 0
      ? median(closedInRange.map((l) => daysBetween(l.start_date, l.ready_date)))
      : null;

    // Rotación (a Despacho): baches DESPACHADOS en el rango,
    // ponderada por kg seco. Antes filtraba por start_date — eso
    // sesgaba contra lotes lentos. Con shipping date el promedio
    // refleja la rotación de lo que efectivamente salió.
    const rotated = filteredAll
      .filter((l) => l.start_date && earliestShipByLot.get(l.id))
      .filter((l) => {
        const range = activeRange();
        const sd = earliestShipByLot.get(l.id);
        if (range && range.from && sd && sd < range.from) return false;
        if (range && range.to   && sd && sd > range.to)   return false;
        return true;
      })
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

    // Pie + barras mensuales: filtran por start_date (entrada).
    const enteredInRange = applyFilters(allLots);

    root.append(filtersRow());

    // ── Panel del bache seleccionado (sticky) ────────────
    if (state.bacheId) {
      const lot = allLots.find((l) => l.id === state.bacheId);
      if (lot) root.append(selectedLotCard(lot));
    }

    root.append(kpiRow([
      kpiCard('En proceso', `${inProcessLots.length} lotes`,
        `${fmtKg(inProcessKg)} kg cereza activa`),
      kpiCard('Tiempo prom. (a Listo)', timeAvg != null ? `${roundN(timeAvg, 1)} días` : '—',
        timeMedian != null ? `mediana ${roundN(timeMedian, 1)} d · ${closedInRange.length} cerrados en rango` : 'sin baches cerrados en rango'),
      kpiCard('Rotación (a Despacho)', rotWeighted != null ? `${roundN(rotWeighted, 1)} días` : '—',
        rotated.length > 0 ? `pond. kg seco · σ ${rotStd != null ? roundN(rotStd, 1) : '—'} d · ${rotated.length} despachados` : 'sin despachos en rango'),
      kpiCard('Activo en secado hoy', fmtKg(dryingActiveKg),
        `${dryingActive.length} lotes (Secado + Descanso)`),
    ]));

    // ── Charts: pie por proceso + barras mensual ─────────
    root.append(el('div', { class: 'grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3' }, [
      chartCard('Cereza por proceso', renderProcessPie(enteredInRange)),
      chartCard('Entrada vs Seco por mes', renderMonthlyBars(enteredInRange),
        'Tooltips al hover. Línea punteada: media móvil 3-m de kg seco. % verde abajo: eficiencia seco/cereza del mes.'),
    ]));

    // ── Distribución por equipo de secado ───────────────
    root.append(chartCard('Kg activos por equipo de secado',
      renderDryingDistribution(filteredAll),
      'Suma kg cereza inicial de baches en Drying agrupados por marquesina/equipo. "Descanso" agrupa los lotes en Resting.'));

    // ── Conversión promedio por proceso (closed in range) ──
    root.append(chartCard('Conversión promedio por proceso',
      renderConversionByProcess(closedInRange),
      'Solo lotes cerrados (Ready/Delivered) en el rango. Conversión = kg_input_initial / kg_dried_output.'));

    // ── Alertas operativas (timing + conversión) ─────────
    root.append(renderAlertsSection(filteredAll, closedInRange));

    // ── Timeline del bache (solo si hay 1 seleccionado) ──
    if (state.bacheId) {
      const lot = allLots.find((l) => l.id === state.bacheId);
      if (lot) root.append(renderLotTimeline(lot, earliestShipByLot.get(lot.id)));
    }
  }

  function renderConversionByProcess(closedLots) {
    const byProc = { Natural: [], Honey: [], Lavado: [] };
    for (const l of closedLots) {
      if (l.conversion_factor == null) continue;
      const cf = Number(l.conversion_factor);
      if (!Number.isFinite(cf) || cf <= 0) continue;
      if (byProc[l.process_type]) byProc[l.process_type].push({ cf, kg: Number(l.kg_dried_output || 0) });
    }
    const cards = ['Natural', 'Honey', 'Lavado'].map((p) => {
      const arr = byProc[p];
      // Promedio ponderado por kg seco final (más representativo
      // que promedio simple — un lote de 5 kg pesa igual que uno
      // de 500).
      const totalKg = arr.reduce((s, x) => s + x.kg, 0);
      let avg = null;
      if (totalKg > 0) avg = arr.reduce((s, x) => s + x.cf * x.kg, 0) / totalKg;
      const target = p === 'Natural' ? '≤ 3.6' : '≤ 5.2';
      return el('div', { class: 'stat-card', style: `border-left:4px solid ${PROCESS_COLORS[p]};` }, [
        el('p', { class: 'stat-label', text: p }),
        el('p', { class: 'stat-val', text: avg != null ? `${roundN(avg, 2)}×` : '—' }),
        el('p', { class: 'stat-sub' }, [
          arr.length === 0 ? 'sin baches cerrados' : `${arr.length} baches · ${fmtKg(totalKg)} seco · objetivo ${target}`,
        ]),
      ]);
    });
    return el('div', { class: 'grid grid-cols-1 sm:grid-cols-3 gap-2' }, cards);
  }

  function renderAlertsSection(active, closedInRange) {
    // 1. Baches en SECADO > 10 días (status=Drying, today - drying_start_date)
    const slowDrying = active
      .filter((l) => l.status === 'Drying' && l.drying_start_date)
      .map((l) => ({ ...l, _days: daysBetween(l.drying_start_date, today) }))
      .filter((l) => l._days > 10)
      .sort((a, b) => b._days - a._days);

    // 2. Baches en FERMENTACIÓN > 5 días (status=InFermentation)
    const slowFerm = active
      .filter((l) => l.status === 'InFermentation' && l.start_date)
      .map((l) => ({ ...l, _days: daysBetween(l.start_date, today) }))
      .filter((l) => l._days > 5)
      .sort((a, b) => b._days - a._days);

    // 3. Baches con END-TO-END > 20 días (cerrados, ready_date - start_date)
    const slowE2E = closedInRange
      .filter((l) => l.start_date && l.ready_date)
      .map((l) => ({ ...l, _days: daysBetween(l.start_date, l.ready_date) }))
      .filter((l) => l._days > 20)
      .sort((a, b) => b._days - a._days);

    // 4. Alertas de conversión (todos los closedInRange, marca rojo
    //    los que se salen de rango por proceso o stage 'seco').
    const convRows = closedInRange
      .filter((l) => l.conversion_factor != null)
      .map((l) => ({ ...l, _alert: conversionAlert(l) }))
      .sort((a, b) => {
        // Rojos primero, luego por mayor conversión
        if (!!a._alert !== !!b._alert) return a._alert ? -1 : 1;
        return Number(b.conversion_factor) - Number(a.conversion_factor);
      });

    return el('div', { class: 'ctrm-card overflow-hidden mb-3' }, [
      el('div', { class: 'px-3 py-2 bg-cream border-b border-sand flex items-baseline justify-between gap-2' }, [
        el('p', { class: 'eyebrow text-[10px]', text: 'Alertas operativas' }),
        el('p', { class: 'text-[10px] text-ink-300 italic',
          text: 'Detección automática de baches lentos o con conversión fuera de rango.' }),
      ]),
      el('div', { class: 'p-3 space-y-3' }, [
        alertTable(
          'Baches en SECADO por más de 10 días',
          ['Bache', 'Proceso', 'kg cereza', 'Equipo', 'Días en secado'],
          slowDrying,
          (l) => [
            bacheLink(l),
            l.process_type || '—',
            fmtKg(l.kg_input_initial ?? l.kg_cherry_input ?? 0),
            (l.drying_locations || []).join(' · ') || '—',
            { text: `${l._days}d`, alert: true },
          ],
          slowDrying.length === 0 ? '✓ Ningún bache excede 10 días en secado.' : null,
        ),
        alertTable(
          'Baches en FERMENTACIÓN por más de 5 días',
          ['Bache', 'Proceso', 'kg cereza', 'Tipo / Tanque', 'Días en ferm.'],
          slowFerm,
          (l) => [
            bacheLink(l),
            l.process_type || '—',
            fmtKg(l.kg_input_initial ?? l.kg_cherry_input ?? 0),
            [
              (l.fermentation_types || []).join(' · '),
              (l.fermentation_tanks || []).join(' · '),
            ].filter(Boolean).join(' · ') || '—',
            { text: `${l._days}d`, alert: true },
          ],
          slowFerm.length === 0 ? '✓ Ningún bache excede 5 días en fermentación.' : null,
        ),
        alertTable(
          'Baches con proceso ENTRADA → LISTO por más de 20 días',
          ['Bache', 'Proceso', 'kg seco', 'Inicio', 'Cierre', 'Total'],
          slowE2E,
          (l) => [
            bacheLink(l),
            l.process_type || '—',
            fmtKg(l.kg_dried_output ?? 0),
            fmtDate(l.start_date),
            fmtDate(l.ready_date),
            { text: `${l._days}d`, alert: true },
          ],
          slowE2E.length === 0 ? '✓ Ningún bache cerrado en el rango supera 20 días end-to-end.' : null,
        ),
        alertTable(
          'Alertas por CONVERSIÓN (lotes cerrados en el rango)',
          ['Bache', 'Proceso', 'Stage inicial', 'kg cereza', 'kg seco', 'Conversión', 'Motivo'],
          convRows,
          (l) => [
            bacheLink(l),
            l.process_type || '—',
            l.processing_stage || '—',
            fmtKg(l.kg_input_initial ?? 0),
            fmtKg(l.kg_dried_output ?? 0),
            { text: `${roundN(Number(l.conversion_factor), 2)}×`, alert: !!l._alert },
            l._alert
              ? { text: l._alert, alert: true, danger: true }
              : { text: 'OK', alert: false },
          ],
          convRows.length === 0 ? 'Sin lotes cerrados en el rango.' : null,
          { showAll: true },   // mostramos todos, no solo los rojos
        ),
      ]),
    ]);
  }

  function bacheLink(l) {
    return el('button', {
      type: 'button',
      class: 'font-mono text-navy font-semibold hover:underline',
      style: 'background:none;border:none;padding:0;cursor:pointer;',
      onClick: (e) => { e.stopPropagation(); navigate(`/finca/bache?id=${l.id}`); },
      text: l.bache_code || l.lot_code || '—',
    });
  }

  function selectedLotCard(lot) {
    const varieties = (lot.varieties || []).map((v) => v.name).join(', ') || '—';
    const kgInicial = lot.kg_input_initial ?? lot.kg_cherry_input;
    return el('div', {
      class: 'ctrm-card overflow-hidden mb-3',
      style: 'background:linear-gradient(135deg,#fbf9d3 0%, #fff 100%);border-left:4px solid #ddae3e;',
    }, [
      el('div', { class: 'px-3 py-2 flex items-baseline justify-between gap-2 flex-wrap' }, [
        el('p', { class: 'eyebrow text-[10px] text-ink-700', text: 'Bache seleccionado · todo el tablero se filtra a este lote' }),
        el('button', {
          type: 'button',
          class: 'ctrm-btn ctrm-btn-ghost ctrm-btn-xs',
          onClick: () => { state.bacheId = null; redraw(); },
        }, ['× Quitar selección']),
      ]),
      el('div', { class: 'px-3 pb-3 grid grid-cols-2 sm:grid-cols-5 gap-x-4 gap-y-2 text-[12px]' }, [
        metaCell('No. Bache', lot.bache_code || lot.lot_code, 'font-mono text-navy font-bold text-[14px]'),
        metaCell('Proceso', lot.process_type || '—'),
        metaCell('Variedad', varieties),
        metaCell('kg inicial', kgInicial != null ? `${fmtKg(kgInicial)} cereza` : '—'),
        metaCell('Etapa actual', statusLabel(lot.status), 'text-navy font-semibold'),
      ]),
    ]);
  }

  function filtersRow() {
    const PRESETS = [
      { key: 'this_month',   label: 'Este mes' },
      { key: 'last_month',   label: 'Mes anterior' },
      { key: 'this_quarter', label: 'Trim. actual' },
      { key: 'last_quarter', label: 'Trim. anterior' },
      { key: 'this_year',    label: 'Año actual' },
      { key: 'last_12',      label: 'Últimos 12 m' },
      { key: 'custom',       label: 'Personalizado' },
    ];
    const periodBtns = PRESETS.map((p) => el('button', {
      type: 'button',
      class: p.key === state.datePreset ? 'ctrm-btn ctrm-btn-primary ctrm-btn-xs' : 'ctrm-btn ctrm-btn-soft ctrm-btn-xs',
      onClick: () => {
        state.datePreset = p.key;
        if (p.key === 'custom' && !state.customFrom && !state.customTo) {
          // Inicializar con el rango actual
          const r = computeDateRange('last_12', today);
          state.customFrom = r.from;
          state.customTo = r.to;
        }
        redraw();
      },
    }, [p.label]));
    const customInputs = state.datePreset === 'custom'
      ? el('div', { class: 'flex items-center gap-1 flex-wrap' }, [
          el('span', { class: 'text-[10px] text-ink-500', text: 'Desde' }),
          el('input', {
            type: 'date', class: 'ctrm-input text-[12px]', value: state.customFrom,
            onInput: (e) => { state.customFrom = e.target.value; redraw(); },
          }),
          el('span', { class: 'text-[10px] text-ink-500', text: 'Hasta' }),
          el('input', {
            type: 'date', class: 'ctrm-input text-[12px]', value: state.customTo,
            onInput: (e) => { state.customTo = e.target.value; redraw(); },
          }),
        ])
      : (() => {
          // Mostrar el rango efectivo del preset como hint
          const r = activeRange();
          return el('span', { class: 'text-[10px] text-ink-500 font-mono',
            text: r && (r.from || r.to)
              ? `${r.from || '…'} → ${r.to || 'hoy'}`
              : 'Sin filtro temporal' });
        })();

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

    const clearBtn = (state.datePreset !== 'last_12' || state.bacheId || state.variety || state.process)
      ? el('button', {
          type: 'button',
          class: 'ctrm-btn ctrm-btn-ghost ctrm-btn-xs',
          onClick: () => {
            state.datePreset = 'last_12'; state.customFrom = ''; state.customTo = '';
            state.bacheId = null; state.variety = ''; state.process = '';
            redraw();
          },
        }, ['Limpiar todo'])
      : null;

    return el('div', { class: 'ctrm-card ctrm-card-pad mb-3' }, [
      el('div', { class: 'flex flex-wrap items-end gap-3' }, [
        el('div', { class: 'flex flex-col gap-1' }, [
          el('span', { class: 'eyebrow text-[10px]', text: 'Período' }),
          el('div', { class: 'flex flex-wrap gap-1' }, periodBtns),
          customInputs,
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
    const secoSeries   = keys.map((k) => byMonth.get(k).seco);

    // Eficiencia = kg_seco / kg_cereza por mes (en %). Sub-label.
    const efficiency = keys.map((k) => {
      const m = byMonth.get(k);
      if (m.cereza <= 0 || m.seco <= 0) return '';
      const pct = (m.seco / m.cereza) * 100;
      return `${pct.toFixed(1)}%`;
    });

    // Media móvil centrada de 3 meses sobre kg seco (tendencia).
    const movingAvg = secoSeries.map((_, i) => {
      const window = secoSeries.slice(Math.max(0, i - 1), Math.min(secoSeries.length, i + 2));
      if (window.length === 0) return null;
      return window.reduce((s, v) => s + v, 0) / window.length;
    });

    return groupedBarChart(labels, [
      { label: 'kg cereza', color: '#a8351c', values: cerezaSeries },
      { label: 'kg seco',   color: '#ddae3e', values: secoSeries },
    ], {
      showDataLabels: true,
      subLabels: efficiency,
      overlayLine: keys.length >= 2
        ? { label: 'Media móvil 3-m (seco)', color: '#1b203d', values: movingAvg }
        : null,
    });
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

// Celda mini del panel del bache seleccionado (label arriba, valor abajo).
function metaCell(label, value, valueClass = '') {
  return el('div', { class: 'min-w-0' }, [
    el('p', { class: 'text-[9px] uppercase tracking-loose text-ink-500 mb-0.5 font-semibold', text: label }),
    el('p', { class: `text-[13px] text-ink-700 truncate ${valueClass}`, text: String(value) }),
  ]);
}

// Reglas de conversión por proceso. Devuelve el motivo de alerta
// o null si está OK.
function conversionAlert(lot) {
  const cf = Number(lot.conversion_factor);
  if (!Number.isFinite(cf) || cf <= 0) return null;
  // Si el bache nació en stage 'seco', conversión real ≈ 1.
  // Cualquier desviación significativa (>1.05) sugiere problemas
  // de captura o pérdidas inusuales.
  if (lot.processing_stage === 'seco') {
    if (cf > 1.05) return `> 1.05 (stage seco)`;
    return null;
  }
  if (lot.process_type === 'Natural') {
    if (cf > 3.6) return `> 3.6 (Natural)`;
  }
  if (lot.process_type === 'Honey' || lot.process_type === 'Lavado') {
    if (cf > 5.2) return `> 5.2 (${lot.process_type})`;
  }
  return null;
}

// Renderiza una tabla compacta de alertas con columnas y filas.
// `rows` es el array de objetos; `rowFn` mapea cada uno a la lista
// de celdas (string o { text, alert, danger }).
function alertTable(title, headers, rows, rowFn, emptyMessage, opts = {}) {
  return el('div', { class: 'bg-white border border-sand rounded-md overflow-hidden' }, [
    el('div', { class: 'px-3 py-2 border-b border-sand flex items-baseline justify-between gap-2' }, [
      el('p', { class: 'font-display font-semibold text-[12px] text-navy', text: title }),
      el('span', { class: 'text-[10px] text-ink-500 font-mono', text: `${rows.length} lote(s)` }),
    ]),
    rows.length === 0
      ? el('p', { class: 'px-3 py-3 text-[11px] text-ok italic', text: emptyMessage || 'Sin resultados.' })
      : el('div', { class: 'overflow-x-auto' }, [
          el('table', { class: 'w-full text-[12px]' }, [
            el('thead', {}, [el('tr', { class: 'bg-cream text-ink-500 uppercase tracking-eyebrow text-[10px]' },
              headers.map((h, i) => el('th', {
                class: `px-3 py-1.5 text-${i === headers.length - 1 ? 'right' : 'left'}`,
                text: h,
              })))]),
            el('tbody', {}, rows.map((r) => {
              const cells = rowFn(r);
              const isRedRow = cells.some((c) => c && typeof c === 'object' && c.danger);
              return el('tr', {
                class: `border-t border-sand ${isRedRow ? 'bg-crit-bg/50' : 'hover:bg-cream'}`,
              }, cells.map((c, i) => {
                if (c instanceof Node) {
                  return el('td', { class: 'px-3 py-1.5' }, [c]);
                }
                const cell = (c && typeof c === 'object') ? c : { text: c };
                const isLast = i === cells.length - 1;
                const cls = `px-3 py-1.5 ${isLast ? 'text-right' : 'text-left'} ${cell.alert ? 'font-mono font-semibold ' + (cell.danger ? 'text-crit' : 'text-warn') : 'text-ink-700'}`;
                return el('td', { class: cls, text: String(cell.text == null ? '—' : cell.text) });
              }));
            })),
          ]),
        ]),
  ]);
}

// Convierte preset → { from, to } YYYY-MM-DD. `today` es la base.
function computeDateRange(preset, todayYmd) {
  const [y, m, d] = todayYmd.split('-').map(Number);
  const Y = y, M = m - 1;
  const ymd = (date) => date.toISOString().slice(0, 10);
  switch (preset) {
    case 'this_month': {
      const from = new Date(Date.UTC(Y, M, 1));
      return { from: ymd(from), to: todayYmd };
    }
    case 'last_month': {
      const from = new Date(Date.UTC(Y, M - 1, 1));
      const to   = new Date(Date.UTC(Y, M, 0));
      return { from: ymd(from), to: ymd(to) };
    }
    case 'this_quarter': {
      const q = Math.floor(M / 3);
      const from = new Date(Date.UTC(Y, q * 3, 1));
      return { from: ymd(from), to: todayYmd };
    }
    case 'last_quarter': {
      const q = Math.floor(M / 3);
      const qFromMonth = q === 0 ? 9 : (q - 1) * 3;
      const yFrom = q === 0 ? Y - 1 : Y;
      const from = new Date(Date.UTC(yFrom, qFromMonth, 1));
      const to   = new Date(Date.UTC(yFrom, qFromMonth + 3, 0));
      return { from: ymd(from), to: ymd(to) };
    }
    case 'this_year': {
      const from = new Date(Date.UTC(Y, 0, 1));
      return { from: ymd(from), to: todayYmd };
    }
    case 'last_12':
    default: {
      const from = new Date(Date.UTC(Y, M - 11, 1));
      return { from: ymd(from), to: todayYmd };
    }
  }
}
