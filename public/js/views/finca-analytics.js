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
// Variante con menos saturación para los stripes laterales de cards
// chicas — el color crudo distrae cuando hay 9 cards juntas.
const PROCS_FAINT = {
  Natural: '#5a8a6a',
  Honey:   '#e0b955',
  Lavado:  '#94afc8',
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

    // Stage averages se calculan SIEMPRE con TODO el histórico
    // (Ready/Delivered, sin filtro de fecha) — esto pidió el
    // usuario para el forecast. Sin esto, rangos cortos darían
    // promedios poco confiables.
    const stageAvgs = computeStageAverages(allLots);

    // ── Conversión promedio por proceso (closed in range) ──
    root.append(chartCard('Conversión promedio por stage de entrada × proceso',
      renderConversionByProcess(closedInRange),
      'Solo lotes cerrados en el rango. Conversión = kg_input_initial / kg_dried_output. Por stage: cereza objetivo ≤ 3.6 (Nat) o ≤ 5.2 (H/L) · despulpado ≤ 3.0 · seco ≤ 1.05. Cards apagados = sin baches en esa combinación.'));

    // ── Tiempo promedio por etapa (Tier 2 #7) ─────────────
    root.append(chartCard('Tiempo promedio por etapa',
      renderStageSplits(stageAvgs),
      'Calculado con TODOS los lotes Ready/Delivered del histórico (ignora el filtro de período).'));

    // ── Antigüedad en bodega de lotes Ready (Tier 2 #8) ──
    root.append(chartCard('Antigüedad en bodega · lotes Ready',
      renderReadyAging(allLots),
      'Snapshot HOY de baches Ready (no Delivered). Sobre 20d hay riesgo de degradación de taza.'));

    // ── Forecast 7d (Tier 4 #15) ──────────────────────────
    root.append(renderForecastSection(allLots, stageAvgs));

    // ── Alertas operativas (timing + conversión + atrasados) ─
    root.append(renderAlertsSection(filteredAll, closedInRange, stageAvgs));

    // ── Timeline del bache (solo si hay 1 seleccionado) ──
    if (state.bacheId) {
      const lot = allLots.find((l) => l.id === state.bacheId);
      if (lot) root.append(renderLotTimeline(lot, earliestShipByLot.get(lot.id)));
    }
  }

  function renderConversionByProcess(closedLots) {
    // Segmenta por (stage de entrada, proceso). Cada celda muestra
    // promedio ponderado por kg seco + cuenta + objetivo.
    // Mostramos solo las celdas que tienen al menos 1 bache.
    const STAGES = [
      { key: 'cereza',     label: 'Entró como CEREZA' },
      { key: 'despulpado', label: 'Entró DESPULPADO' },
      { key: 'seco',       label: 'Entró SECO' },
    ];
    const PROCS = ['Natural', 'Honey', 'Lavado'];
    const buckets = {};
    for (const s of STAGES) {
      buckets[s.key] = {};
      for (const p of PROCS) buckets[s.key][p] = [];
    }
    for (const l of closedLots) {
      if (l.conversion_factor == null) continue;
      const cf = Number(l.conversion_factor);
      if (!Number.isFinite(cf) || cf <= 0) continue;
      const stage = l.processing_stage || 'cereza';
      if (!buckets[stage] || !buckets[stage][l.process_type]) continue;
      buckets[stage][l.process_type].push({ cf, kg: Number(l.kg_dried_output || 0) });
    }

    const sections = STAGES.map((s) => {
      const cards = PROCS.map((p) => {
        const arr = buckets[s.key][p];
        const totalKg = arr.reduce((sum, x) => sum + x.kg, 0);
        const avg = totalKg > 0
          ? arr.reduce((sum, x) => sum + x.cf * x.kg, 0) / totalKg
          : null;
        const target = conversionTarget(s.key, p);
        return el('div', {
          class: 'stat-card',
          style: `border-left:4px solid ${PROCS_FAINT[p] || '#9aa3ae'};${arr.length === 0 ? 'opacity:0.45;' : ''}`,
        }, [
          el('p', { class: 'stat-label', text: p }),
          el('p', { class: 'stat-val',
            text: avg != null ? `${roundN(avg, 2)}×` : '—' }),
          el('p', { class: 'stat-sub' }, [
            arr.length === 0
              ? 'sin baches'
              : `${arr.length} baches · ${fmtKg(totalKg)} seco · obj ${target}`,
          ]),
        ]);
      });
      // Total cuenta para el header de la sección
      const stageTotal = PROCS.reduce((sum, p) => sum + buckets[s.key][p].length, 0);
      return el('div', { class: 'space-y-1' }, [
        el('p', { class: 'eyebrow text-[10px] text-ink-500',
          text: `${s.label} · ${stageTotal} bache(s)` }),
        el('div', { class: 'grid grid-cols-1 sm:grid-cols-3 gap-2' }, cards),
      ]);
    });

    return el('div', { class: 'space-y-3' }, sections);
  }

  function renderAlertsSection(active, closedInRange, stageAvgs) {
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

    // 3. Baches ACTIVOS (sin llegar a Punto Final) con start_date
    //    > 20 días — antes mostraba cerrados, ajustado para solo
    //    los que siguen en proceso y no han cerrado.
    const slowE2E = active
      .filter((l) => l.start_date && ACTIVE_STATUSES.has(l.status))
      .map((l) => ({ ...l, _days: daysBetween(l.start_date, today) }))
      .filter((l) => l._days > 20)
      .sort((a, b) => b._days - a._days);

    // 4. ATRASADOS — baches activos cuyo tiempo en su etapa actual
    //    supera el promedio histórico del proceso (por proceso). Si
    //    no hay histórico para ese proceso, no entra en la lista.
    const overdue = [];
    for (const l of active) {
      if (!ACTIVE_STATUSES.has(l.status)) continue;
      const exp = expectedStageDays(l, stageAvgs);
      if (exp == null) continue;
      const dInStage = daysInCurrentStage(l, today);
      if (dInStage == null || exp <= 0) continue;
      const delay = dInStage - exp;
      if (delay > 0.5) {
        overdue.push({
          ...l,
          _stage: stageName(l.status),
          _dInStage: dInStage,
          _expected: exp,
          _delay: delay,
        });
      }
    }
    overdue.sort((a, b) => b._delay - a._delay);

    // 5. Alertas de conversión (todos los closedInRange, marca rojo
    //    los que se salen de rango por proceso o stage 'seco').
    const convRows = closedInRange
      .filter((l) => l.conversion_factor != null)
      .map((l) => ({ ...l, _alert: conversionAlert(l) }))
      .sort((a, b) => {
        if (!!a._alert !== !!b._alert) return a._alert ? -1 : 1;
        return Number(b.conversion_factor) - Number(a.conversion_factor);
      });

    return el('div', { class: 'ctrm-card overflow-hidden mb-3' }, [
      el('div', { class: 'px-3 py-2 bg-cream border-b border-sand flex items-baseline justify-between gap-2' }, [
        el('p', { class: 'eyebrow text-[10px]', text: 'Alertas operativas' }),
        el('p', { class: 'text-[10px] text-ink-300 italic',
          text: 'Cada tabla es desplegable. Conteo en el header.' }),
      ]),
      el('div', { class: 'p-3 space-y-2' }, [
        alertTable(
          'Baches en SECADO por más de 10 días',
          ['Bache', 'Proceso', 'Variedad', 'kg cereza', 'Equipo', 'Días en secado'],
          slowDrying,
          (l) => [
            bacheLink(l),
            l.process_type || '—',
            varietyNames(l),
            fmtKg(l.kg_input_initial ?? l.kg_cherry_input ?? 0),
            (l.drying_locations || []).join(' · ') || '—',
            { text: `${l._days}d`, alert: true },
          ],
          '✓ Ningún bache excede 10 días en secado.',
        ),
        alertTable(
          'Baches en FERMENTACIÓN por más de 5 días',
          ['Bache', 'Proceso', 'Variedad', 'kg cereza', 'Tipo / Tanque', 'Días en ferm.'],
          slowFerm,
          (l) => [
            bacheLink(l),
            l.process_type || '—',
            varietyNames(l),
            fmtKg(l.kg_input_initial ?? l.kg_cherry_input ?? 0),
            [
              (l.fermentation_types || []).join(' · '),
              (l.fermentation_tanks || []).join(' · '),
            ].filter(Boolean).join(' · ') || '—',
            { text: `${l._days}d`, alert: true },
          ],
          '✓ Ningún bache excede 5 días en fermentación.',
        ),
        alertTable(
          'Baches ACTIVOS con > 20 días sin llegar a Punto Final',
          ['Bache', 'Proceso', 'Variedad', 'Etapa actual', 'kg cereza', 'Inicio', 'Días en proceso'],
          slowE2E,
          (l) => [
            bacheLink(l),
            l.process_type || '—',
            varietyNames(l),
            statusLabel(l.status),
            fmtKg(l.kg_input_initial ?? l.kg_cherry_input ?? 0),
            fmtDate(l.start_date),
            { text: `${l._days}d`, alert: true },
          ],
          '✓ Ningún bache activo lleva más de 20 días sin cerrar.',
        ),
        alertTable(
          'ATRASADOS — más días en su etapa que el promedio del proceso',
          ['Bache', 'Proceso', 'Variedad', 'Etapa actual', 'Días en etapa', 'Promedio', 'Atraso'],
          overdue,
          (l) => [
            bacheLink(l),
            l.process_type || '—',
            varietyNames(l),
            l._stage,
            { text: `${roundN(l._dInStage, 1)}d`, alert: true },
            { text: `${roundN(l._expected, 1)}d` },
            { text: `+${roundN(l._delay, 1)}d`, alert: true, danger: true },
          ],
          '✓ Ningún bache excede el promedio del proceso en su etapa actual.',
        ),
        alertTable(
          'Alertas por CONVERSIÓN (lotes cerrados en el rango)',
          ['Bache', 'Proceso', 'Variedad', 'Stage inicial', 'kg cereza', 'kg seco', 'Conversión', 'Motivo'],
          convRows,
          (l) => [
            bacheLink(l),
            l.process_type || '—',
            varietyNames(l),
            l.processing_stage || '—',
            fmtKg(l.kg_input_initial ?? 0),
            fmtKg(l.kg_dried_output ?? 0),
            { text: `${roundN(Number(l.conversion_factor), 2)}×`, alert: !!l._alert },
            l._alert
              ? { text: l._alert, alert: true, danger: true }
              : { text: 'OK', alert: false },
          ],
          'Sin lotes cerrados en el rango.',
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

  // ── Tiempo promedio por etapa (Tier 2 #7) ─────────────────
  function renderStageSplits(stageAvgs) {
    const procs = ['Natural', 'Honey', 'Lavado'];
    const procCount = stageAvgs.__counts || {};
    return el('div', { class: 'overflow-x-auto' }, [
      el('table', { class: 'w-full text-[12px]' }, [
        el('thead', {}, [el('tr', { class: 'text-ink-500 uppercase tracking-eyebrow text-[10px] bg-cream' }, [
          el('th', { class: 'px-3 py-1.5 text-left', text: 'Proceso' }),
          el('th', { class: 'px-3 py-1.5 text-right', text: 'Fermentación' }),
          el('th', { class: 'px-3 py-1.5 text-right', text: 'Secado' }),
          el('th', { class: 'px-3 py-1.5 text-right', text: 'Descanso' }),
          el('th', { class: 'px-3 py-1.5 text-right', text: 'Total' }),
          el('th', { class: 'px-3 py-1.5 text-right', text: 'n' }),
        ])]),
        el('tbody', {}, procs.map((p) => {
          const a = stageAvgs[p] || {};
          const total = (a.ferm || 0) + (a.drying || 0) + (a.resting || 0);
          return el('tr', { class: 'border-t border-sand' }, [
            el('td', { class: 'px-3 py-2' }, [
              el('span', { style: `display:inline-block;width:8px;height:8px;background:${PROCESS_COLORS[p]};border-radius:2px;margin-right:6px;` }),
              document.createTextNode(p),
            ]),
            el('td', { class: 'px-3 py-2 text-right font-mono', text: a.ferm    != null ? `${roundN(a.ferm, 1)}d` : '—' }),
            el('td', { class: 'px-3 py-2 text-right font-mono', text: a.drying  != null ? `${roundN(a.drying, 1)}d` : '—' }),
            el('td', { class: 'px-3 py-2 text-right font-mono', text: a.resting != null ? `${roundN(a.resting, 1)}d` : '—' }),
            el('td', { class: 'px-3 py-2 text-right font-mono font-bold text-navy',
              text: total > 0 ? `${roundN(total, 1)}d` : '—' }),
            el('td', { class: 'px-3 py-2 text-right font-mono text-ink-500',
              text: String(procCount[p] || 0) }),
          ]);
        })),
      ]),
    ]);
  }

  // ── Antigüedad en bodega de lotes Ready (Tier 2 #8) ──────
  function renderReadyAging(lots) {
    const readyLots = lots.filter((l) => l.status === 'Ready' && l.ready_date);
    const buckets = [
      { label: '0–10 días',  min: 0,  max: 10, color: '#5d8b66', desc: 'fresco' },
      { label: '11–20 días', min: 11, max: 20, color: '#ddae3e', desc: 'atención' },
      { label: '> 20 días',  min: 21, max: 9999, color: '#a8351c', desc: 'crítico' },
    ];
    const enriched = readyLots.map((l) => ({
      ...l,
      _days: daysBetween(l.ready_date, today),
      _kgDry: Number(l.kg_dried_output || 0),
    }));
    const bars = buckets.map((b) => {
      const inBucket = enriched.filter((l) => l._days >= b.min && l._days <= b.max);
      const kg = inBucket.reduce((s, l) => s + l._kgDry, 0);
      return {
        label: b.label,
        value: kg,
        color: b.color,
        sublabel: `${inBucket.length} ${inBucket.length === 1 ? 'lote' : 'lotes'} · ${b.desc}`,
      };
    });
    if (readyLots.length === 0) {
      return el('p', { class: 'text-[12px] text-ink-300 italic text-center py-6',
        text: 'No hay lotes Ready en bodega.' });
    }
    return horizontalBarChart(bars);
  }

  // ── Forecast 7d (Tier 4 #15) ───────────────────────────────
  function renderForecastSection(lots, stageAvgs) {
    const active = lots.filter((l) => ACTIVE_STATUSES.has(l.status));
    const projections = active
      .map((l) => ({ l, proj: forecastCloseDate(l, today, stageAvgs) }))
      .filter((x) => x.proj != null);

    // Buckets +0..+7, "+7d a +30d" agrupa, vencidos = lleva más
    // días en su etapa que el promedio.
    const buckets = [];
    for (let i = 0; i <= 7; i++) {
      const date = addDays(today, i);
      buckets.push({ key: String(i), label: i === 0 ? 'Hoy' : `+${i}d`, date, items: [] });
    }
    const over7 = { key: 'over7', label: '+7 a +30d', date: null, items: [] };
    const overdue = { key: 'overdue', label: 'Vencidos', date: null, items: [] };

    for (const { l, proj } of projections) {
      const d = proj.daysFromNow;
      if (proj.overdue) overdue.items.push({ l, proj });
      else if (d <= 7) buckets[d].items.push({ l, proj });
      else if (d <= 30) over7.items.push({ l, proj });
      else over7.items.push({ l, proj });
    }

    const allBuckets = [...buckets, over7, overdue];
    const totalKg = allBuckets.reduce((s, b) =>
      s + b.items.reduce((ss, x) => ss + estimateClosingKg(x.l), 0), 0);
    const totalLots = allBuckets.reduce((s, b) => s + b.items.length, 0);

    // Calendar visual: barras verticales por bucket con conteo + kg
    const maxKgBar = Math.max(1, ...allBuckets.map((b) =>
      b.items.reduce((s, x) => s + estimateClosingKg(x.l), 0)));

    const calendarRow = el('div', { class: 'grid grid-cols-10 gap-1' },
      allBuckets.map((b) => {
        const kg = b.items.reduce((s, x) => s + estimateClosingKg(x.l), 0);
        const barH = maxKgBar > 0 ? (kg / maxKgBar) * 60 : 0;
        const isOver = b.key === 'overdue';
        const color = isOver ? '#a8351c' : b.key === 'over7' ? '#9aa3ae' : '#3a6f4a';
        return el('div', { class: 'flex flex-col items-center gap-1 text-center' }, [
          el('div', { class: 'h-[70px] flex items-end justify-center w-full' }, [
            el('div', {
              style: `width:80%;height:${Math.max(2, barH)}px;background:${color};border-radius:2px 2px 0 0;`,
              title: `${b.label}: ${b.items.length} lotes · ${fmtKg(kg)}`,
            }),
          ]),
          el('p', { class: 'text-[10px] text-ink-500 font-mono', text: b.label }),
          el('p', { class: 'text-[10px] font-mono text-ink-700 font-semibold', text: `${b.items.length}` }),
          el('p', { class: 'text-[9px] text-ink-300 font-mono', text: fmtShortKg(kg) }),
        ]);
      }));

    // Lotes que cierran en los próximos 7 días
    const next7 = projections
      .filter((x) => !x.proj.overdue && x.proj.daysFromNow <= 7)
      .sort((a, b) => a.proj.daysFromNow - b.proj.daysFromNow);

    return el('div', { class: 'ctrm-card overflow-hidden mb-3' }, [
      el('div', { class: 'px-3 py-2 bg-cream border-b border-sand flex items-baseline justify-between gap-2 flex-wrap' }, [
        el('p', { class: 'eyebrow text-[10px]', text: 'Forecast 7 días' }),
        el('p', { class: 'text-[10px] text-ink-500 font-mono' }, [
          `${totalLots} lotes activos · `,
          el('strong', { class: 'text-navy', text: fmtKg(totalKg) }),
          ` proyectado (estimación con promedios históricos)`,
        ]),
      ]),
      el('div', { class: 'p-3 space-y-3' }, [
        calendarRow,
        next7.length === 0
          ? el('p', { class: 'text-[12px] text-ink-300 italic text-center py-3',
              text: 'Ningún lote cierra en los próximos 7 días según la proyección.' })
          : el('div', { class: 'overflow-x-auto' }, [
              el('table', { class: 'w-full text-[12px]' }, [
                el('thead', {}, [el('tr', { class: 'text-ink-500 uppercase tracking-eyebrow text-[10px] bg-cream' }, [
                  el('th', { class: 'px-3 py-1.5 text-left', text: 'Bache' }),
                  el('th', { class: 'px-3 py-1.5 text-left', text: 'Proceso' }),
                  el('th', { class: 'px-3 py-1.5 text-left', text: 'Etapa actual' }),
                  el('th', { class: 'px-3 py-1.5 text-right', text: 'Días aquí' }),
                  el('th', { class: 'px-3 py-1.5 text-left', text: 'Cierre proyectado' }),
                  el('th', { class: 'px-3 py-1.5 text-right', text: 'kg seco est.' }),
                ])]),
                el('tbody', {}, next7.map(({ l, proj }) => el('tr', { class: 'border-t border-sand hover:bg-cream' }, [
                  el('td', { class: 'px-3 py-2' }, [bacheLink(l)]),
                  el('td', { class: 'px-3 py-2', text: l.process_type || '—' }),
                  el('td', { class: 'px-3 py-2 text-[11px]', text: proj.stage }),
                  el('td', { class: 'px-3 py-2 text-right font-mono',
                    text: `${proj.daysInStage != null ? roundN(proj.daysInStage, 1) : '?'}d` }),
                  el('td', { class: 'px-3 py-2 font-mono text-[11px]' }, [
                    document.createTextNode(fmtDate(proj.date)),
                    el('span', { class: 'text-ink-500 ml-1',
                      text: `(${proj.daysFromNow === 0 ? 'hoy' : '+' + proj.daysFromNow + 'd'})` }),
                  ]),
                  el('td', { class: 'px-3 py-2 text-right font-mono',
                    text: fmtKg(estimateClosingKg(l)) }),
                ]))),
              ]),
            ]),
      ]),
    ]);
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

// ── Forecast / Splits helpers ─────────────────────────────────

// Para cada proceso, calcula promedios de días en cada etapa
// (Fermentación, Secado, Descanso) usando TODOS los lotes
// Ready/Delivered del histórico. El usuario eligió usar todo el
// histórico para evitar promedios poco confiables con ventanas
// cortas.
function computeStageAverages(allLots) {
  const procs = ['Natural', 'Honey', 'Lavado'];
  const groups = {};
  const counts = {};
  for (const p of procs) {
    groups[p] = { ferm: [], drying: [], resting: [] };
    counts[p] = 0;
  }
  for (const l of allLots) {
    if (!(l.status === 'Ready' || l.status === 'Delivered')) continue;
    if (!groups[l.process_type]) continue;
    counts[l.process_type] += 1;
    const g = groups[l.process_type];
    // Fermentación: start_date → drying_start_date
    if (l.start_date && l.drying_start_date) {
      g.ferm.push(daysBetween(l.start_date, l.drying_start_date));
    }
    // Secado total: drying_start_date → primer resting.start_date
    // o ready_date si no hubo descanso.
    if (l.drying_start_date) {
      const cycles = (l.resting_cycles || []).slice()
        .sort((a, b) => a.cycle_number - b.cycle_number);
      const dryEnd = cycles.length > 0 ? cycles[0].start_date : l.ready_date;
      if (dryEnd) g.drying.push(daysBetween(l.drying_start_date, dryEnd));
    }
    // Descanso: por cada ciclo cerrado.
    for (const c of (l.resting_cycles || [])) {
      if (c.start_date && c.end_date) {
        g.resting.push(daysBetween(c.start_date, c.end_date));
      }
    }
  }
  const out = { __counts: counts };
  for (const p of procs) {
    out[p] = {
      ferm:    mean(groups[p].ferm),
      drying:  mean(groups[p].drying),
      resting: mean(groups[p].resting),
    };
  }
  return out;
}

function mean(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

// Días que el bache lleva en su ETAPA ACTUAL (no en el proceso
// total). Para Drying usa drying_start_date; para Resting usa
// start_date del ciclo activo; para InFermentation usa
// start_date del bache.
function daysInCurrentStage(lot, today) {
  if (lot.status === 'InFermentation' && lot.start_date) {
    return daysBetween(lot.start_date, today);
  }
  if (lot.status === 'Drying' && lot.drying_start_date) {
    return daysBetween(lot.drying_start_date, today);
  }
  if (lot.status === 'Resting') {
    const cycles = (lot.resting_cycles || []).slice()
      .sort((a, b) => b.cycle_number - a.cycle_number);
    const active = cycles.find((c) => !c.end_date) || cycles[0];
    if (active && active.start_date) return daysBetween(active.start_date, today);
  }
  return null;
}

// Promedio histórico de la etapa actual del lote (días que se
// espera que dure esa etapa según promedio del proceso).
function expectedStageDays(lot, stageAvgs) {
  if (!stageAvgs || !stageAvgs[lot.process_type]) return null;
  const a = stageAvgs[lot.process_type];
  if (lot.status === 'InFermentation') return a.ferm;
  if (lot.status === 'Drying')         return a.drying;
  if (lot.status === 'Resting')        return a.resting;
  return null;
}

function stageName(status) {
  if (status === 'InFermentation') return 'Fermentación';
  if (status === 'Drying')         return 'Secado';
  if (status === 'Resting')        return 'Descanso';
  return status;
}

// Proyecta fecha de cierre (llegada a Ready) sumando los días que
// le faltan en la etapa actual + las siguientes etapas según
// promedios. Si está atrasado en su etapa actual (más días de lo
// esperado), marca overdue=true y cierre proyectado = HOY.
function forecastCloseDate(lot, today, stageAvgs) {
  if (!stageAvgs || !stageAvgs[lot.process_type]) return null;
  const a = stageAvgs[lot.process_type];
  const inStage = daysInCurrentStage(lot, today);
  let remaining = 0;
  let overdue = false;
  let stageLabelText = '';
  if (lot.status === 'InFermentation') {
    stageLabelText = 'Fermentación';
    if (a.ferm == null) return null;
    if (inStage > a.ferm) overdue = true;
    remaining += Math.max(0, (a.ferm || 0) - (inStage || 0));
    remaining += a.drying  || 0;
    remaining += a.resting || 0;
  } else if (lot.status === 'Drying') {
    stageLabelText = 'Secado';
    if (a.drying == null) return null;
    if (inStage > a.drying) overdue = true;
    remaining += Math.max(0, (a.drying || 0) - (inStage || 0));
    remaining += a.resting || 0;
  } else if (lot.status === 'Resting') {
    stageLabelText = 'Descanso';
    if (a.resting == null) return null;
    if (inStage > a.resting) overdue = true;
    remaining += Math.max(0, (a.resting || 0) - (inStage || 0));
  } else {
    return null;
  }
  const daysFromNow = Math.round(remaining);
  const dateMs = new Date(today + 'T00:00:00Z').getTime() + daysFromNow * 86400000;
  return {
    daysFromNow,
    date: new Date(dateMs).toISOString().slice(0, 10),
    stage: stageLabelText,
    daysInStage: inStage,
    overdue,
  };
}

// Estima kg seco final del bache aplicando la conversión promedio
// de su proceso (más conservador que asumir factor 1).
function estimateClosingKg(lot) {
  if (lot.kg_dried_output != null && Number(lot.kg_dried_output) > 0) {
    return Number(lot.kg_dried_output);
  }
  const cereza = Number(lot.kg_input_initial ?? lot.kg_cherry_input ?? 0);
  if (cereza <= 0) return 0;
  // Divisores típicos por proceso (factor de conversión cereza→seco)
  const divisor = lot.process_type === 'Natural' ? 3.4
                : lot.process_type === 'Honey'   ? 1.7
                : lot.process_type === 'Lavado'  ? 1.34
                : 3.0;
  return cereza / divisor;
}

function addDays(ymd, days) {
  const ms = new Date(ymd + 'T00:00:00Z').getTime() + days * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function fmtShortKg(n) {
  const v = Number(n || 0);
  if (v >= 1000) return `${(v / 1000).toFixed(1)}t`;
  return `${Math.round(v)}`;
}

// Devuelve los nombres de variedades del lote separados por coma,
// o "—" si no tiene. Para las tablas de alertas.
function varietyNames(lot) {
  const arr = (lot.varieties || []).map((v) => v.name).filter(Boolean);
  return arr.length > 0 ? arr.join(', ') : '—';
}

// Reglas de conversión según el stage DE ENTRADA del bache.
// La etapa inicial manda: si arrancó ya despulpado o ya seco no
// tiene sentido aplicar el umbral de Lavado-cereza (5.2). Cada
// stage tiene su propio rango esperado:
//
//   cereza     → Natural ≤ 3.6 · Honey/Lavado ≤ 5.2
//   despulpado → todos los procesos ≤ 3.0  (rango típico 2.5-3.0)
//   seco       → todos los procesos ≤ 1.05 (debe estar ≈ 1)
//
// Devuelve el motivo de alerta o null si está OK.
function conversionAlert(lot) {
  const cf = Number(lot.conversion_factor);
  if (!Number.isFinite(cf) || cf <= 0) return null;
  const stage = lot.processing_stage;

  if (stage === 'seco') {
    if (cf > 1.05) return `> 1.05 (entró seco)`;
    return null;
  }
  if (stage === 'despulpado') {
    if (cf > 3.0) return `> 3.0 (entró despulpado)`;
    return null;
  }
  // Stage = cereza (o no informado): aplica el umbral por proceso.
  if (lot.process_type === 'Natural' && cf > 3.6) {
    return `> 3.6 (Natural / cereza)`;
  }
  if ((lot.process_type === 'Honey' || lot.process_type === 'Lavado') && cf > 5.2) {
    return `> 5.2 (${lot.process_type} / cereza)`;
  }
  return null;
}

// Umbral esperado por (stage, proceso) — sirve para mostrar el
// objetivo en cada card de conversión KPI.
function conversionTarget(stage, processType) {
  if (stage === 'seco') return '≤ 1.05';
  if (stage === 'despulpado') return '≤ 3.0';
  if (processType === 'Natural') return '≤ 3.6';
  return '≤ 5.2';   // Honey / Lavado / default
}

// Renderiza una tabla compacta de alertas en <details> colapsable.
// Por defecto se abre si tiene resultados, se cierra si está vacía.
// `rows` es el array de objetos; `rowFn` mapea cada uno a la lista
// de celdas (string o { text, alert, danger }).
function alertTable(title, headers, rows, rowFn, emptyMessage) {
  const hasRows = rows.length > 0;
  const summary = el('summary', {
    class: 'px-3 py-2 cursor-pointer flex items-baseline justify-between gap-2 hover:bg-cream',
  }, [
    el('p', { class: 'font-display font-semibold text-[12px] text-navy', text: title }),
    el('span', {
      class: `text-[10px] font-mono ${hasRows ? 'text-crit font-bold' : 'text-ok'}`,
      text: hasRows ? `${rows.length} lote(s) ▾` : '✓ sin alertas',
    }),
  ]);

  const body = hasRows
    ? el('div', { class: 'overflow-x-auto border-t border-sand' }, [
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
      ])
    : el('p', { class: 'px-3 py-3 text-[11px] text-ok italic border-t border-sand',
        text: emptyMessage || 'Sin resultados.' });

  const det = el('details', {
    class: 'bg-white border border-sand rounded-md overflow-hidden',
  }, [summary, body]);
  if (hasRows) det.setAttribute('open', 'true');
  return det;
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
