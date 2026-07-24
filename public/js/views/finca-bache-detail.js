// Vista de detalle de un bache. Ruta: /finca/bache?id=<uuid>.
// Muestra todos los datos del bache, un timeline editable de las
// etapas por las que pasó y permite avanzar a las siguientes etapas
// desde la parte superior. Bloqueada la edición cuando el bache ya
// está Delivered.

import { el, clear } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { openModal } from '../ui/modal.js';
import { fmtKg, fmtDate, statusLabel, statusPillKind } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { currentQuery, navigate } from '../router.js';
import { withBusy } from '../ui/busy.js';
import {
  NEXT_TRANSITIONS,
  advanceStatus as advanceStatusShared,
  editBacheModal,
  callWithPlausibilityConfirm,
} from './_bache-actions.js';
import { generateLotPassportPdf } from '../ui/pdf.js';

export async function fincaBacheDetailView() {
  const id = currentQuery().get('id');
  if (!id) {
    return chrome(el('div', { class: 'p-6' }, [
      el('p', { class: 'text-[13px] text-ink-700', text: 'Falta el id del bache en la URL.' }),
      el('button', { class: 'ctrm-btn ctrm-btn-soft mt-3', type: 'button',
        onClick: () => navigate('/finca/lots') }, ['← Volver a Producción']),
    ]));
  }

  let lot = null;
  async function load() {
    const r = await api.lotsList({ id });
    lot = (r.lots || [])[0] || null;
  }
  await load();
  if (!lot) {
    return chrome(el('div', { class: 'p-6' }, [
      el('p', { class: 'text-[13px] text-ink-700', text: `Bache ${id.slice(0, 8)}… no encontrado.` }),
      el('button', { class: 'ctrm-btn ctrm-btn-soft mt-3', type: 'button',
        onClick: () => navigate('/finca/lots') }, ['← Volver a Producción']),
    ]));
  }

  const root = el('div', {});

  async function reload() {
    await load();
    redraw();
  }

  async function runAdvance(target) {
    try {
      const r = await advanceStatusShared(lot, target);
      if (r === null) return;
      toast(`${lot.bache_code || lot.lot_code} → ${statusLabel(target)}`, 'success');
      if (r && r.completions && r.completions.length > 0) {
        toast(`${r.completions.length} pedido(s) completado(s)`, 'success', 4500);
      }
      await reload();
    } catch (e) {
      console.error('advanceStatus failed', e);
      toast(e.message || 'Error en el cambio de estado', 'error', 6000);
    }
  }

  function redraw() {
    clear(root);
    const isLocked = lot.status === 'Delivered';
    const transitions = NEXT_TRANSITIONS[lot.status] || { primary: null, secondary: [] };
    const heroColor = HERO_COLORS[lot.status] || HERO_COLORS.default;
    const heroLabel = HERO_LABELS[lot.status] || statusLabel(lot.status).toUpperCase();
    const varietyNames = (lot.varieties || []).map((v) => v.name).join(', ') || '—';
    const isDried = lot.kg_dried_output != null && lot.kg_dried_output > 0;
    const isClosed = lot.status === 'Ready' || lot.status === 'Delivered';

    // root.append(...) acepta argumentos pero convierte null a "null"
    // (texto literal). Por eso construimos el contenido vía el('div', {}, [...])
    // que sí filtra nulos.
    root.append(el('div', {}, [
      // ── Breadcrumb ──
      el('div', { class: 'mb-2' }, [
        el('button', {
          type: 'button',
          class: 'text-[11px] font-display uppercase tracking-eyebrow text-ink-500 hover:text-navy inline-flex items-center gap-1',
          style: 'background:none;border:none;padding:0;cursor:pointer;',
          onClick: () => navigate('/finca/lots'),
        }, ['← Producción']),
      ]),

      // ── Hero banner: status grande + KPIs + título + acciones ──
      el('div', { class: 'ctrm-card overflow-hidden mb-4' }, [
        // Fila superior: bloque de status + grid de KPIs.
        el('div', { class: 'flex flex-col md:flex-row' }, [
          // Status block (color por etapa, label grande).
          el('div', {
            class: 'flex flex-col items-center justify-center px-6 py-5 md:min-w-[180px]',
            style: `background:${heroColor};color:#fff;`,
          }, [
            el('span', {
              class: 'font-display uppercase tracking-eyebrow text-[10px] opacity-80 mb-1',
              text: 'Estado',
            }),
            el('span', {
              class: 'font-display font-bold uppercase tracking-eyebrow text-[20px] leading-tight',
              text: heroLabel,
            }),
            ...(lot.status === 'Drying' && (lot.drying_locations || []).length > 0
              ? [el('span', { class: 'text-[11px] font-mono opacity-90 mt-2',
                  text: (lot.drying_locations || []).join(' · ') })]
              : []),
            ...(lot.status === 'Resting' && lot.resting_humidity != null
              ? [el('span', { class: 'text-[11px] font-mono opacity-90 mt-2',
                  text: `Humedad ${lot.resting_humidity}%` })]
              : []),
          ]),
          // KPI grid.
          el('div', {
            class: 'flex-1 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 px-5 py-4',
          }, [
            heroKpi('Variedad', varietyNames, 'text-[12px]'),
            heroKpi('Inicial', lot.kg_input_initial != null ? fmtKg(lot.kg_input_initial) : '—',
              null, stageLabel(lot.processing_stage)),
            isDried
              ? heroKpi('Café seco', fmtKg(lot.kg_dried_output), null,
                  lot.factor_rendimiento != null ? `factor ${lot.factor_rendimiento}` : null)
              : heroKpi('Café seco', '—', 'text-ink-300', null),
            isClosed && lot.conversion_factor != null
              ? heroKpi('Conversión', `${lot.conversion_factor}×`)
              : isClosed && lot.kg_green_actual != null
                ? heroKpi('Verde real', fmtKg(lot.kg_green_actual))
                : heroKpi('Conversión', '—', 'text-ink-300'),
          ]),
        ]),
        // Fila inferior: título + botones de acción.
        el('div', { class: 'px-5 py-3 border-t border-sand bg-cream flex flex-wrap items-center justify-between gap-3' }, [
          el('div', { class: 'flex items-center gap-2 flex-wrap min-w-0' }, [
            el('span', { class: 'ctrm-code text-[13px]', text: lot.bache_code || lot.lot_code }),
            (lot.bache_code && lot.bache_code !== lot.lot_code)
              ? el('span', { class: 'text-[10px] text-ink-300 font-mono', text: lot.lot_code })
              : null,
            lot.reference_name
              ? el('span', { class: 'font-display font-semibold text-navy text-[13px]', text: lot.reference_name })
              : el('span', { class: 'font-display italic text-ink-300 text-[13px]', text: 'Sin referencia' }),
            el('span', { class: 'text-[11px] text-ink-500 font-mono' }, [
              `${lot.process_type || '—'}`,
              lot.client_name ? ` · ${lot.client_name}` : '',
              (lot.resting_cycles_count || 0) > 1
                ? ` · ${lot.resting_cycles_count} descansos` : '',
            ]),
          ]),
          el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
            !isLocked
              ? el('button', {
                  class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
                  type: 'button',
                  onClick: async () => {
                    const r = await editBacheModal(lot);
                    if (r && r.ok) await reload();
                  },
                }, ['Editar bache'])
              : null,
            transitions.primary && !isLocked
              ? el('button', {
                  class: 'ctrm-btn ctrm-btn-primary ctrm-btn-sm',
                  onClick: () => runAdvance(transitions.primary.target),
                }, [transitions.primary.label])
              : null,
            ...((!isLocked ? transitions.secondary || [] : []).map((t) =>
              el('button', {
                class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
                onClick: () => runAdvance(t.target),
              }, [t.label]))),
            lot.status === 'Ready'
              ? el('button', {
                  class: 'ctrm-btn ctrm-btn-yellow ctrm-btn-sm',
                  onClick: () => navigate('/finca/despachos'),
                }, ['Despachar'])
              : null,
            (lot.status === 'Ready' || lot.status === 'Delivered')
              ? el('button', {
                  class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
                  title: 'Descargar hoja de vida del lote (PDF A4)',
                  onClick: () => {
                    try { generateLotPassportPdf(lot); }
                    catch (e) { toast(e.message || 'Error al generar la hoja de vida', 'error'); }
                  },
                }, ['↓ Lot Passport'])
              : null,
            (lot.status === 'Ready' || lot.status === 'Delivered')
              ? el('button', {
                  class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
                  title: 'Corregir kg seco de entrada a Punto Final (por error de captura)',
                  onClick: async () => {
                    const r = await adjustDriedModal(lot);
                    if (r && r.ok) await reload();
                  },
                }, ['Ajustar peso seco'])
              : null,
            lot.status === 'Ready'
              ? el('button', {
                  class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
                  title: 'Agregar retroactivamente un ciclo de descanso que se omitió',
                  onClick: async () => {
                    const r = await addRestingCycleModal(lot);
                    if (r && r.ok) await reload();
                  },
                }, ['+ Descanso retroactivo'])
              : null,
            isLocked
              ? el('span', { class: 'text-[11px] italic text-ink-300',
                  text: 'Bache despachado · edición limitada. Usa "Ajustar peso seco" para correcciones.' })
              : null,
          ]),
        ]),
      ]),

      // ── Datos del bache ──
      el('div', { class: 'ctrm-card overflow-hidden mb-4' }, [
        el('div', { class: 'px-3 py-2 bg-cream border-b border-sand flex items-center justify-between' }, [
          el('p', { class: 'eyebrow text-[10px]', text: 'Datos del bache' }),
        ]),
        el('div', { class: 'p-3 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 text-[12px]' }, [
          metaField('Fecha de inicio', fmtDate(lot.start_date)),
          metaField('Cereza inicial', lot.kg_input_initial != null ? fmtKg(lot.kg_input_initial) : '—'),
          metaField('Verde esperado', fmtKg(lot.kg_green_expected)),
          metaField('Café seco', lot.kg_dried_output != null ? fmtKg(lot.kg_dried_output) : '—'),
          metaField('Factor', lot.factor_rendimiento != null ? String(lot.factor_rendimiento) : '—'),
          metaField('Verde real', lot.kg_green_actual != null ? fmtKg(lot.kg_green_actual) : '—'),
          metaField('Variedades', (lot.varieties || []).map((v) => v.name).join(', ') || '—'),
          metaField('Conversión', lot.conversion_factor != null ? `${lot.conversion_factor}×` : '—'),
          metaField('Infusión', lot.infusion_name ? `${lot.infusion_name} ${lot.infusion_pct}%` : '—'),
        ]),
        lot.notes ? el('div', { class: 'px-3 pb-3 border-t border-sand pt-3' }, [
          el('p', { class: 'text-[10px] uppercase tracking-loose text-ink-300 mb-1', text: 'Observaciones' }),
          el('p', { class: 'text-[12px] text-ink-700 whitespace-pre-line', text: lot.notes }),
        ]) : null,
      ]),

      // ── Evolución (stepper) ──
      el('div', { class: 'ctrm-card overflow-hidden mb-4' }, [
        el('div', { class: 'px-3 py-2 bg-cream border-b border-sand' }, [
          el('p', { class: 'eyebrow text-[10px]', text: 'Evolución' }),
        ]),
        el('div', { class: 'p-4' }, [renderEvolution(lot)]),
      ]),

      // ── Historial detallado (editable) ──
      el('div', { class: 'ctrm-card overflow-hidden mb-4' }, [
        el('div', { class: 'px-3 py-2 bg-cream border-b border-sand' }, [
          el('p', { class: 'eyebrow text-[10px]', text: 'Historial' }),
        ]),
        el('div', { class: 'p-3' }, [renderHistory(lot, isLocked, reload)]),
      ]),

      // ── Pedidos asignados ──
      (lot.assignments || []).length > 0
        ? el('div', { class: 'ctrm-card overflow-hidden mb-4' }, [
            el('div', { class: 'px-3 py-2 bg-cream border-b border-sand' }, [
              el('p', { class: 'eyebrow text-[10px]', text: `Pedidos asignados (${(lot.assignments || []).length})` }),
            ]),
            el('div', { class: 'divide-y divide-sand' }, (lot.assignments || []).map((a) => {
              const o = a.order || {};
              return el('div', { class: 'px-3 py-2 flex items-center justify-between gap-2 text-[12px]' }, [
                el('div', { class: 'flex items-center gap-2 flex-wrap min-w-0' }, [
                  o.id
                    ? el('button', {
                        type: 'button',
                        class: 'ctrm-code text-[10px] hover:underline',
                        style: 'background:none;border:none;padding:2px 6px;cursor:pointer;',
                        onClick: () => navigate(`/pedido?id=${o.id}`),
                        text: o.order_code || '—',
                      })
                    : el('span', { class: 'ctrm-code text-[10px]', text: o.order_code || '—' }),
                  o.status ? el('span', { class: `ctrm-pill text-[10px] ${statusPillKind(o.status)}`, text: statusLabel(o.status) }) : null,
                  o.max_delivery_date ? el('span', { class: 'text-[10px] text-ink-500 font-mono', text: `Entrega ${fmtDate(o.max_delivery_date)}` }) : null,
                ]),
                el('span', { class: 'font-mono font-semibold text-ink-700', text: fmtKg(a.kg_green_allocated) }),
              ]);
            })),
          ])
        : null,

      // ── Parciales ──
      (lot.partials || []).filter((p) => !p.rejected_at).length > 0
        ? el('div', { class: 'ctrm-card overflow-hidden mb-4' }, [
            el('div', { class: 'px-3 py-2 bg-cream border-b border-sand' }, [
              el('p', { class: 'eyebrow text-[10px]', text: `Parciales (${(lot.partials || []).filter((p) => !p.rejected_at).length} / 6)` }),
            ]),
            el('div', { class: 'overflow-x-auto' }, [
              el('table', { class: 'w-full text-[11px]' }, [
                el('thead', {}, [el('tr', { class: 'text-ink-300 uppercase tracking-loose' }, [
                  el('th', { class: 'text-left px-3 py-1.5' }, ['Parcial']),
                  el('th', { class: 'text-left px-3 py-1.5' }, ['Fecha']),
                  el('th', { class: 'text-right px-3 py-1.5' }, ['kg seco']),
                  el('th', { class: 'text-right px-3 py-1.5' }, ['Factor']),
                  el('th', { class: 'text-right px-3 py-1.5' }, ['kg verde']),
                ])]),
                el('tbody', {}, (lot.partials || []).filter((p) => !p.rejected_at)
                  .slice().sort((a, b) => a.parcial_letter.localeCompare(b.parcial_letter))
                  .map((p) => el('tr', { class: 'border-t border-sand' }, [
                    el('td', { class: 'px-3 py-1.5 font-mono font-semibold', text: p.parcial_letter }),
                    el('td', { class: 'px-3 py-1.5 font-mono', text: fmtDate(p.completed_at || p.created_at) }),
                    el('td', { class: 'px-3 py-1.5 text-right font-mono', text: fmtKg(p.kg_dried) }),
                    el('td', { class: 'px-3 py-1.5 text-right font-mono', text: String(p.factor_rendimiento) }),
                    el('td', { class: 'px-3 py-1.5 text-right font-mono font-bold', text: fmtKg(p.kg_green_yield) }),
                  ]))),
              ]),
            ]),
          ])
        : null,
    ]));
  }
  redraw();

  return chrome(el('div', {}, [
    pageTitle('Detalle del bache', lot.bache_code || lot.lot_code),
    root,
  ]));
}

function metaField(label, value) {
  return el('div', {}, [
    el('p', { class: 'text-[10px] uppercase tracking-loose text-ink-300 mb-0.5', text: label }),
    el('p', { class: 'font-mono text-ink-700 text-[13px]', text: String(value) }),
  ]);
}

// Hero KPI block (label arriba, valor grande, opcional hint).
function heroKpi(label, value, valueClass, hint) {
  return el('div', { class: 'min-w-0' }, [
    el('p', { class: 'text-[10px] uppercase tracking-eyebrow text-ink-500 mb-0.5 font-display font-semibold', text: label }),
    el('p', { class: `font-display font-semibold text-navy text-[16px] leading-tight ${valueClass || ''}`,
      text: String(value) }),
    hint ? el('p', { class: 'text-[10px] text-ink-500 font-mono mt-0.5', text: hint }) : null,
  ]);
}

// Colores y labels grandes del bloque de status en el hero. El status
// pill chiquito sigue presente en el resto del sistema; aquí lo
// elevamos a tipografía 20px sobre fondo de color.
const HERO_COLORS = {
  InFermentation: '#7e9ec1', // navy-soft
  Drying:         '#ddae3e', // mustard
  Resting:        '#a8b89c', // sage
  Ready:          '#5d8b66', // forest
  Delivered:      '#9aa3ae', // ink-300
  default:        '#1a3a5c', // navy
};
const HERO_LABELS = {
  InFermentation: 'Fermentación',
  Drying:         'Secado',
  Resting:        'Descanso',
  Ready:          'Listo',
  Delivered:      'Despachado',
};

// ── Historial ──────────────────────────────────────────────────────
// Reconstruye los eventos desde los timestamps + ciclos de descanso.
// Cada evento muestra fecha + título + detalle, y un botón ✎ para
// editar SÓLO la fecha (lo demás se edita en sus respectivos flows).
// ── Construcción de eventos (compartida entre stepper y timeline) ──
// Cada evento es { kind, date, title, detail, color, editable?, onEditDate? }.
// kind se usa para colorear el bullet en el stepper.
function buildEvents(lot, isLocked) {
  const events = [];

  if (lot.start_date) {
    const fTypes = (lot.fermentation_types || []).join(' · ');
    const fTanks = (lot.fermentation_tanks || []).join(' · ');
    const detailLines = [
      `${stageLabel(lot.processing_stage)} · ${lot.kg_input_initial != null ? fmtKg(lot.kg_input_initial) : '—'}`,
      fTypes ? `Tipos: ${fTypes}` : null,
      fTanks ? `Tanques: ${fTanks}` : null,
    ].filter(Boolean);
    events.push({
      kind: 'start',
      date: lot.start_date,
      title: 'Fermentación iniciada',
      detail: detailLines.join('\n'),
      color: EVENT_COLOR.start,
      editable: !isLocked,
      editConfig: {
        showDate: true, dateField: 'start_date', dateTarget: 'lot',
        showFermentationTanks: true, showFermentationTypes: true,
        currentFermentationTanks: lot.fermentation_tanks || [],
        currentFermentationTypes: lot.fermentation_types || [],
      },
      undoKind: null, // creación no se anula desde aquí
    });
  }

  if (lot.drying_start_date) {
    // Calcular horas reales de fermentación si hay timestamps precisos.
    let fermDetail = '';
    if (lot.fermentation_start_at && lot.drying_start_at) {
      const start = new Date(lot.fermentation_start_at).getTime();
      const end   = new Date(lot.drying_start_at).getTime();
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const realHours = Math.round((end - start) / 3600000);
        const planHours = Number(lot.fermentation_hours || 0);
        fermDetail = planHours > 0
          ? `Fermentación · Plan: ${planHours}h · Real: ${realHours}h`
          : `Fermentación real: ${realHours}h`;
      }
    }
    const locDetail = (lot.drying_locations || []).length > 0
      ? `Marquesinas: ${(lot.drying_locations || []).join(' · ')}`
      : 'Sin marquesinas registradas';
    events.push({
      kind: 'drying',
      date: lot.drying_start_date,
      title: '→ Secado',
      detail: fermDetail ? `${locDetail}\n${fermDetail}` : locDetail,
      color: EVENT_COLOR.drying,
      editable: !isLocked,
      editConfig: {
        showDate: true, dateField: 'drying_start_date', dateTarget: 'lot',
        showLocations: true,
        locationsTarget: 'lot', locationsField: 'drying_locations',
        currentLocations: lot.drying_locations || [],
      },
      undoKind: 'drying', // → InFermentation
    });
  }

  const cycles = (lot.resting_cycles || []).slice().sort((a, b) => a.cycle_number - b.cycle_number);
  for (const c of cycles) {
    events.push({
      kind: 'resting-in',
      date: c.start_date,
      title: `→ Descanso · ciclo ${c.cycle_number}`,
      detail: `Humedad entrada: ${c.start_humidity}%${maxDaysHint(c.start_humidity)}`,
      color: EVENT_COLOR.resting,
      editable: !isLocked,
      editConfig: {
        showDate: true, dateField: 'start_date', dateTarget: 'cycle', cycleId: c.id,
        showHumidity: true, humidityField: 'start_humidity', humidityTarget: 'cycle',
        humidityLabel: 'Humedad de entrada (%)',
        currentHumidity: c.start_humidity,
      },
      undoKind: 'resting-in',
      cycleId: c.id,
    });
    if (c.end_date) {
      const backToDrying = c.end_reason === 'back_to_drying';
      const cycleLocs = c.drying_locations_after || [];
      const exitDetailParts = [
        `Humedad salida: ${c.end_humidity != null ? c.end_humidity + '%' : '—'}`,
      ];
      if (backToDrying) {
        exitDetailParts.push(cycleLocs.length > 0
          ? `Marquesinas: ${cycleLocs.join(' · ')}`
          : 'Sin marquesinas registradas');
      }
      events.push({
        kind: backToDrying ? 'back-to-drying' : 'ready-from-resting',
        date: c.end_date,
        title: backToDrying ? '← Volver a Secado' : '→ Listo',
        detail: exitDetailParts.join('\n'),
        color: backToDrying ? EVENT_COLOR.drying : EVENT_COLOR.ready,
        editable: !isLocked,
        editConfig: {
          showDate: true,
          dateField: backToDrying ? 'end_date' : 'ready_date',
          dateTarget: backToDrying ? 'cycle' : 'lot',
          cycleId: c.id,
          showHumidity: true, humidityField: 'end_humidity', humidityTarget: 'cycle',
          humidityLabel: backToDrying ? 'Humedad de salida (%)' : 'Humedad final (%)',
          currentHumidity: c.end_humidity,
          // Para back-to-drying: editar marquesinas DEL ciclo (drying_locations_after)
          showLocations: backToDrying,
          locationsTarget: backToDrying ? 'cycle' : null,
          locationsField:  backToDrying ? 'drying_locations_after' : null,
          currentLocations: backToDrying ? cycleLocs : null,
          // Para ready-from-resting también se editan kg
          showKg: !backToDrying,
          currentKg: !backToDrying ? {
            kg_dried_output: lot.kg_dried_output,
            factor_rendimiento: lot.factor_rendimiento,
            kg_green_actual: lot.kg_green_actual,
          } : null,
        },
        undoKind: backToDrying ? 'back-to-drying' : 'ready-from-resting',
        cycleId: c.id,
      });
    }
  }

  const lastCycle = cycles[cycles.length - 1];
  const readyFromResting = lastCycle && lastCycle.end_reason === 'to_ready' && lastCycle.end_date === lot.ready_date;
  if (lot.ready_date && !readyFromResting) {
    events.push({
      kind: 'ready-from-drying',
      date: lot.ready_date,
      title: '→ Listo',
      detail: [
        lot.kg_dried_output != null ? `Seco ${fmtKg(lot.kg_dried_output)}` : null,
        lot.factor_rendimiento != null ? `Factor ${lot.factor_rendimiento}` : null,
        lot.kg_green_actual != null ? `Verde ${fmtKg(lot.kg_green_actual)}` : null,
        lot.final_humidity != null ? `Humedad ${lot.final_humidity}%` : null,
      ].filter(Boolean).join(' · '),
      color: EVENT_COLOR.ready,
      editable: !isLocked,
      editConfig: {
        showDate: true, dateField: 'ready_date', dateTarget: 'lot',
        showHumidity: true, humidityField: 'final_humidity', humidityTarget: 'lot',
        humidityLabel: 'Humedad final (%)',
        currentHumidity: lot.final_humidity,
        showKg: true,
        currentKg: {
          kg_dried_output: lot.kg_dried_output,
          factor_rendimiento: lot.factor_rendimiento,
          kg_green_actual: lot.kg_green_actual,
        },
      },
      undoKind: 'ready-from-drying',
    });
  } else if (lot.ready_date && readyFromResting) {
    const ev = events[events.length - 1];
    const yieldDetail = [
      lot.kg_dried_output != null ? `Seco ${fmtKg(lot.kg_dried_output)}` : null,
      lot.factor_rendimiento != null ? `Factor ${lot.factor_rendimiento}` : null,
      lot.kg_green_actual != null ? `Verde ${fmtKg(lot.kg_green_actual)}` : null,
    ].filter(Boolean).join(' · ');
    if (yieldDetail) ev.detail = `${ev.detail}\n${yieldDetail}`;
  }

  if (lot.delivered_date) {
    events.push({
      kind: 'delivered',
      date: lot.delivered_date,
      title: '→ Despachado',
      detail: '',
      color: EVENT_COLOR.delivered,
      editable: false,
      editConfig: null,
      undoKind: null, // despachado no se anula desde el historial
    });
  }

  // Ordenar por fecha asc (estable). Eventos con misma fecha mantienen
  // el orden de construcción, así que ciclo 1 va antes de ciclo 2.
  return events
    .map((ev, i) => ({ ev, i }))
    .sort((a, b) => {
      const da = a.ev.date || '';
      const db = b.ev.date || '';
      if (da !== db) return da < db ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.ev);
}

const EVENT_COLOR = {
  start:     '#7e9ec1', // navy-soft
  drying:    '#ddae3e', // mustard
  resting:   '#a8b89c', // sage
  ready:     '#5d8b66', // forest
  delivered: '#9aa3ae', // ink-300
};

// ── Stepper horizontal — resumen visual del historial ──
function renderEvolution(lot) {
  const events = buildEvents(lot, true);
  if (events.length === 0) {
    return el('p', { class: 'text-[12px] text-ink-300 italic', text: 'Sin eventos registrados.' });
  }
  if (events.length === 1) {
    // Único bullet centrado.
    return el('div', { class: 'flex justify-center py-2' }, [stepperBullet(events[0])]);
  }

  // Calcular días entre cada par de eventos.
  const segments = [];
  for (let i = 0; i < events.length - 1; i++) {
    segments.push({ days: daysBetween(events[i].date, events[i + 1].date) });
  }
  const totalDays = segments.reduce((s, x) => s + x.days, 0);

  const children = [];
  for (let i = 0; i < events.length; i++) {
    children.push(stepperBullet(events[i]));
    if (i < events.length - 1) {
      // flex-grow proporcional a los días; mínimo 1 para tramos de 0d.
      const seg = segments[i];
      const grow = Math.max(1, seg.days || 1);
      children.push(stepperSegment(seg, grow, events[i].color));
    }
  }
  return el('div', { class: 'space-y-3' }, [
    el('div', { class: 'flex items-stretch overflow-x-auto', style: 'min-height:96px;' }, children),
    el('div', { class: 'flex items-center justify-end gap-3 text-[11px] font-mono text-ink-500' }, [
      el('span', {}, [
        el('span', { class: 'text-ink-300 uppercase tracking-loose text-[10px] mr-1', text: 'Total' }),
        el('strong', { class: 'text-navy', text: `${totalDays}d` }),
      ]),
    ]),
  ]);
}

function stepperBullet(ev) {
  return el('div', { class: 'flex flex-col items-center text-center shrink-0', style: 'min-width:110px;' }, [
    el('span', { class: 'font-mono text-[10px] text-ink-500', text: fmtDate(ev.date) }),
    el('span', {
      class: 'inline-block w-4 h-4 rounded-full border-2 border-white my-1',
      style: `background:${ev.color};box-shadow:0 0 0 2px ${ev.color};`,
    }),
    el('span', { class: 'font-display text-[11px] text-navy font-semibold leading-tight whitespace-nowrap', text: ev.title }),
    ev.detail
      ? el('span', { class: 'text-[10px] text-ink-500 font-mono leading-tight mt-0.5 max-w-[140px]',
          style: 'white-space:normal;', text: ev.detail.split('\n')[0] })
      : null,
  ]);
}

function stepperSegment(seg, grow, color) {
  return el('div', {
    class: 'flex flex-col items-center justify-start pt-[18px]',
    style: `flex:${grow} 1 0;min-width:32px;`,
  }, [
    el('span', { class: 'font-display text-[10px] uppercase tracking-eyebrow text-ink-500 mb-1',
      text: `${seg.days}d` }),
    el('span', {
      class: 'block w-full h-[3px] rounded-full',
      style: `background:${color};opacity:0.5;`,
    }),
  ]);
}

function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return 0;
  const a = new Date(fromIso + 'T00:00:00Z');
  const b = new Date(toIso   + 'T00:00:00Z');
  return Math.max(0, Math.floor((b - a) / 86400000));
}

function renderHistory(lot, isLocked, reload) {
  const events = buildEvents(lot, isLocked);
  return el('div', { class: 'space-y-3' }, events.map((ev, i) => {
    const isLast = i === events.length - 1;
    const canUndo = isLast && !isLocked && ev.undoKind != null;
    return el('div', { class: 'flex gap-3' }, [
      el('div', { class: 'flex flex-col items-center pt-1 shrink-0' }, [
        el('span', { class: 'inline-block w-2 h-2 rounded-full',
          style: `background:${ev.color};` }),
        !isLast ? el('span', { class: 'flex-1 w-px bg-sand mt-1', style: 'min-height:24px;' }) : null,
      ]),
      el('div', { class: 'flex-1 min-w-0 pb-2' }, [
        el('div', { class: 'flex items-baseline justify-between gap-2 flex-wrap' }, [
          el('div', { class: 'flex items-baseline gap-2 flex-wrap' }, [
            el('span', { class: 'font-mono text-[11px] text-ink-500', text: fmtDate(ev.date) }),
            el('span', { class: 'font-display text-[13px] text-navy font-semibold', text: ev.title }),
          ]),
          el('div', { class: 'flex items-center gap-1.5' }, [
            ev.editable && ev.editConfig
              ? el('button', {
                  type: 'button',
                  class: 'ctrm-btn ctrm-btn-primary ctrm-btn-xs',
                  title: 'Editar fecha, humedad o kg',
                  onClick: () => editEventModal(ev, lot, reload),
                }, ['Editar'])
              : null,
            canUndo
              ? el('button', {
                  type: 'button',
                  class: 'ctrm-btn ctrm-btn-soft ctrm-btn-xs text-crit',
                  title: 'Anular este paso y volver al estado anterior',
                  onClick: () => undoEventModal(ev, lot, reload),
                }, ['Anular'])
              : null,
          ]),
        ]),
        ev.detail
          ? el('p', { class: 'text-[11px] text-ink-500 font-mono whitespace-pre-line mt-0.5', text: ev.detail })
          : null,
      ]),
    ]);
  }));
}

// Modal de edición de evento. Según ev.editConfig muestra los inputs
// relevantes (fecha, humedad, marquesinas, kg, tanques/tipos de
// fermentación) y dispatches al endpoint apropiado:
//   lotUpdate                → campos del lote (drying_locations, fermentation_*)
//   lotRestingCycleUpdate    → campos del ciclo (drying_locations_after, etc.)
async function editEventModal(ev, lot, reload) {
  const cfg = ev.editConfig || {};
  // Pre-cargas en paralelo según lo que pida la config.
  const [dryRes, tankRes, typeRes] = await Promise.all([
    cfg.showLocations ? api.dryingTypesList({}).catch(() => null) : Promise.resolve(null),
    cfg.showFermentationTanks ? api.fermentationTanksList({}).catch(() => null) : Promise.resolve(null),
    cfg.showFermentationTypes ? api.fermentationTypesList({}).catch(() => null) : Promise.resolve(null),
  ]);
  let dryingTypeNames = ['Silos', 'Patio'];
  if (dryRes && Array.isArray(dryRes.drying_types) && dryRes.drying_types.length > 0) {
    dryingTypeNames = dryRes.drying_types.map((t) => t.name);
  }
  const tankNames = (tankRes && tankRes.fermentation_tanks)
    ? tankRes.fermentation_tanks.map((t) => t.name)
    : [];
  const typeNames = (typeRes && typeRes.fermentation_types)
    ? typeRes.fermentation_types.map((t) => t.name)
    : [];

  openModal(({ close }) => {
    const dateInput = cfg.showDate ? el('input', {
      type: 'date', value: ev.date || '', class: 'ctrm-input',
    }) : null;

    const humInput = cfg.showHumidity ? el('input', {
      type: 'number', step: '0.1', min: '0', max: '100',
      value: cfg.currentHumidity != null ? String(cfg.currentHumidity) : '',
      placeholder: 'Ej: 11.0', class: 'ctrm-input mono',
    }) : null;

    // Marquesinas — se guardan donde diga locationsTarget (lot/cycle)
    const locCbs = cfg.showLocations ? dryingTypeNames.map((loc) => ({
      loc,
      cb: el('input', { type: 'checkbox', value: loc, class: 'mr-2',
        checked: (cfg.currentLocations || []).includes(loc) ? 'true' : null,
      }),
    })) : null;

    const tankCbs = cfg.showFermentationTanks ? tankNames.map((name) => ({
      name,
      cb: el('input', { type: 'checkbox', value: name, class: 'mr-2',
        checked: (cfg.currentFermentationTanks || []).includes(name) ? 'true' : null,
      }),
    })) : null;
    const typeCbs = cfg.showFermentationTypes ? typeNames.map((name) => ({
      name,
      cb: el('input', { type: 'checkbox', value: name, class: 'mr-2',
        checked: (cfg.currentFermentationTypes || []).includes(name) ? 'true' : null,
      }),
    })) : null;

    const KG_PER_SACO = 70;
    const kgInputs = cfg.showKg ? {
      dried: el('input', {
        type: 'number', step: '0.01', min: '0',
        value: cfg.currentKg && cfg.currentKg.kg_dried_output != null ? String(cfg.currentKg.kg_dried_output) : '',
        class: 'ctrm-input mono', placeholder: 'Peso seco',
      }),
      factor: el('input', {
        type: 'number', step: '0.01', min: '0.01',
        value: cfg.currentKg && cfg.currentKg.factor_rendimiento != null ? String(cfg.currentKg.factor_rendimiento) : '',
        class: 'ctrm-input mono', placeholder: 'Factor',
      }),
      green: el('input', {
        type: 'number', step: '0.01', min: '0',
        value: cfg.currentKg && cfg.currentKg.kg_green_actual != null ? String(cfg.currentKg.kg_green_actual) : '',
        class: 'ctrm-input mono', placeholder: 'kg verde',
      }),
    } : null;
    // Auto-recalcular kg verde cuando cambia seco o factor. Si el
    // operario edita verde a mano se marca greenEdited para no
    // pisar su valor. Fórmula estándar: verde = (seco / factor) × 70.
    if (kgInputs) {
      let greenEdited = kgInputs.green.value !== '';
      const recompute = () => {
        if (greenEdited) return;
        const seco = Number(kgInputs.dried.value || 0);
        const fac  = Number(kgInputs.factor.value || 0);
        if (seco > 0 && fac > 0) {
          kgInputs.green.value = String(Math.round((seco / fac) * KG_PER_SACO * 100) / 100);
        } else {
          kgInputs.green.value = '';
        }
      };
      kgInputs.dried.addEventListener('input', recompute);
      kgInputs.factor.addEventListener('input', recompute);
      kgInputs.green.addEventListener('input', () => {
        greenEdited = kgInputs.green.value !== '';
      });
    }

    function chipGroup(items) {
      return el('div', { class: 'flex flex-wrap gap-2' },
        items.map(({ name, cb }) => el('label', {
          class: 'inline-flex items-center text-[12px] px-3 py-1.5 border border-sand rounded-md cursor-pointer hover:bg-cream',
        }, [cb, el('span', { text: name })])));
    }

    return el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-[12px] text-ink-700' }, [
        `Editar `, el('strong', { class: 'text-navy', text: ev.title }),
      ]),
      dateInput ? el('label', { class: 'ctrm-label', text: 'Fecha' }) : null,
      dateInput,
      humInput ? el('label', { class: 'ctrm-label mt-2', text: cfg.humidityLabel || 'Humedad (%)' }) : null,
      humInput,
      locCbs ? el('label', { class: 'ctrm-label mt-2', text: 'Marquesinas / equipo de secado' }) : null,
      locCbs ? el('div', { class: 'flex flex-wrap gap-2' },
        locCbs.map(({ loc, cb }) => el('label', {
          class: 'inline-flex items-center text-[12px] px-3 py-1.5 border border-sand rounded-md cursor-pointer hover:bg-cream',
        }, [cb, el('span', { text: loc })]))) : null,
      tankCbs ? el('label', { class: 'ctrm-label mt-2', text: 'Tanques de fermentación' }) : null,
      tankCbs ? (tankCbs.length > 0
        ? chipGroup(tankCbs)
        : el('p', { class: 'text-[11px] text-ink-300 italic',
            text: 'No hay tanques administrados. Añádelos en /admin/config.' })) : null,
      typeCbs ? el('label', { class: 'ctrm-label mt-2', text: 'Tipos de fermentación' }) : null,
      typeCbs ? (typeCbs.length > 0
        ? chipGroup(typeCbs)
        : el('p', { class: 'text-[11px] text-ink-300 italic',
            text: 'No hay tipos administrados. Añádelos en /admin/config.' })) : null,
      kgInputs ? el('label', { class: 'ctrm-label mt-2', text: 'Peso seco (kg)' }) : null,
      kgInputs ? kgInputs.dried : null,
      kgInputs ? el('label', { class: 'ctrm-label mt-2', text: 'Factor de rendimiento' }) : null,
      kgInputs ? kgInputs.factor : null,
      kgInputs ? el('label', { class: 'ctrm-label mt-2', text: 'kg verde reales' }) : null,
      kgInputs ? kgInputs.green : null,
      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-primary', type: 'button',
          onClick: async (e) => {
            const btn = e.currentTarget;
            const lotFields = {};
            const cycleFields = {};

            if (dateInput && dateInput.value && dateInput.value !== ev.date) {
              if (cfg.dateTarget === 'cycle') cycleFields[cfg.dateField] = dateInput.value;
              else                            lotFields[cfg.dateField]   = dateInput.value;
            }
            if (humInput) {
              const v = humInput.value === '' ? '' : Number(humInput.value);
              if (v === '' || (Number.isFinite(v) && v >= 8 && v <= 40) || (cfg.humidityField === 'final_humidity' && Number.isFinite(v) && v >= 0 && v <= 100)) {
                if (cfg.humidityTarget === 'cycle') cycleFields[cfg.humidityField] = v;
                else                                lotFields[cfg.humidityField]   = v;
              } else {
                toast(`Humedad: rango inválido`, 'warning'); return;
              }
            }
            if (locCbs) {
              const picked = locCbs.filter(({ cb }) => cb.checked).map(({ loc }) => loc);
              if (picked.length === 0) {
                toast('Selecciona al menos una marquesina', 'warning'); return;
              }
              const field = cfg.locationsField || 'drying_locations';
              if (cfg.locationsTarget === 'cycle') cycleFields[field] = picked;
              else                                 lotFields[field]   = picked;
            }
            if (tankCbs) {
              lotFields.fermentation_tanks = tankCbs.filter(({ cb }) => cb.checked).map(({ name }) => name);
            }
            if (typeCbs) {
              lotFields.fermentation_types = typeCbs.filter(({ cb }) => cb.checked).map(({ name }) => name);
            }
            if (kgInputs) {
              const parse = (s) => s === '' ? '' : Number(s);
              lotFields.kg_dried_output    = parse(kgInputs.dried.value);
              lotFields.factor_rendimiento = parse(kgInputs.factor.value);
              lotFields.kg_green_actual    = parse(kgInputs.green.value);
            }

            try {
              let declined = false;
              await withBusy(btn, 'Guardando…', async () => {
                if (Object.keys(lotFields).length > 0) {
                  const r = await callWithPlausibilityConfirm((override) =>
                    api.lotUpdate({
                      lot_id: lot.id, fields: lotFields,
                      ...(override ? { override_plausibility: true } : {}),
                    }));
                  if (r === null) { declined = true; return; }
                }
                if (Object.keys(cycleFields).length > 0 && cfg.cycleId) {
                  await api.lotRestingCycleUpdate({ cycle_id: cfg.cycleId, fields: cycleFields });
                }
              });
              if (declined) return;   // el operario no confirmó el peso — modal sigue abierta
              toast('Cambios guardados', 'success');
              close({ ok: true });
              reload();
            } catch (err) {
              console.error('editEventModal failed', err);
              toast(err.message || 'Error al guardar', 'error', 6000);
            }
          },
        }, ['Guardar']),
      ]),
    ]);
  }, { title: `Editar ${ev.title}` });
}

function undoEventModal(ev, lot, reload) {
  openModal(({ close }) => {
    return el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-[12px] text-ink-700 leading-relaxed' }, [
        `¿Anular el paso `, el('strong', { class: 'text-navy', text: ev.title }), `?`,
      ]),
      el('p', { class: 'text-[11px] text-warn',
        text: 'El bache volverá al estado anterior. Los datos registrados en este paso (humedad, kg, etc.) se borran.' }),
      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-danger', type: 'button',
          onClick: async (e) => {
            const btn = e.currentTarget;
            try {
              await withBusy(btn, 'Anulando…', () => api.lotUndoStage({
                lot_id: lot.id, event_kind: ev.undoKind, cycle_id: ev.cycleId,
              }));
              toast('Paso anulado', 'success');
              close({ ok: true });
              reload();
            } catch (err) {
              toast(err.message || 'Error al anular', 'error', 6000);
            }
          },
        }, ['Anular paso']),
      ]),
    ]);
  }, { title: 'Anular paso' });
}

function stageLabel(stage) {
  if (stage === 'cereza')     return 'Cereza fresca';
  if (stage === 'despulpado') return 'Despulpado';
  if (stage === 'seco')       return 'Café seco';
  return stage || '—';
}

function maxDaysHint(h) {
  const v = Number(h);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v > 20)  return ' · máx 5d';
  if (v >= 14) return ' · máx 8d';
  return '';
}

// Modal para corregir kg_dried_output post-cierre. Sirve tanto en
// Ready como en Delivered. Si en Delivered el nuevo valor deja
// saldo, el backend reverte el bache a Ready + limpia
// delivered_date. Anexa auditoría a notes.
async function adjustDriedModal(lot) {
  const oldDried = Number(lot.kg_dried_output || 0);
  const oldGreen = Number(lot.kg_green_actual || 0);
  const alreadyOut = Number(
    (lot.kg_dried_used_in_blends || 0) + (lot.kg_dried_shipped || 0),
  );
  const currentAvail = Math.max(0, oldDried - alreadyOut);

  return openModal(({ close }) => {
    const newInput = el('input', {
      type: 'number', step: '0.01', min: '0.01',
      value: String(oldDried),
      class: 'ctrm-input mono w-full',
    });
    const reasonInput = el('textarea', {
      rows: '3',
      class: 'ctrm-textarea w-full',
      placeholder: 'Motivo obligatorio · queda en notas del bache',
    });

    // Preview reactivo
    const previewGreen  = el('strong', { class: 'font-mono' });
    const previewAvail  = el('strong', { class: 'font-mono' });
    const previewFactor = el('strong', { class: 'font-mono' });
    const previewRevert = el('p', { class: 'text-[11px] mt-1' });
    const previewWarn   = el('p', { class: 'text-[11px] text-crit mt-1', style: 'display:none;' });

    function refreshPreview() {
      const newDried = Number(newInput.value || 0);
      // Green escalado proporcionalmente
      const newGreen = oldDried > 0 && oldGreen > 0
        ? oldGreen * (newDried / oldDried)
        : newGreen;
      const newAvail = newDried - alreadyOut;
      // Mezclas: la entrada acompaña al seco → conversión siempre 1×.
      const newFactor = lot.is_blend
        ? (newDried > 0 ? 1 : null)
        : (lot.kg_input_initial > 0 && newDried > 0
            ? Number(lot.kg_input_initial) / newDried
            : null);
      previewGreen.textContent  = `${fmtKg(newGreen)} verde`;
      previewAvail.textContent  = `${fmtKg(Math.max(0, newAvail))} kg`;
      previewFactor.textContent = newFactor != null ? `${Math.round(newFactor * 100) / 100}×` : '—';
      // Warnings
      if (newAvail + 0.01 < 0) {
        previewWarn.textContent = `⚠ El nuevo valor deja inventario negativo. Mínimo permitido: ${fmtKg(alreadyOut)}.`;
        previewWarn.style.display = '';
      } else {
        previewWarn.style.display = 'none';
      }
      // Info de revert
      if (lot.status === 'Delivered' && newAvail > 0.01) {
        previewRevert.className = 'text-[11px] mt-1 text-ok';
        previewRevert.textContent = `→ Al guardar, el bache vuelve a Listo (Punto Final) con ${fmtKg(newAvail)} kg de saldo.`;
      } else if (lot.status === 'Delivered' && newAvail <= 0.01) {
        previewRevert.className = 'text-[11px] mt-1 text-ink-500';
        previewRevert.textContent = 'El bache queda Delivered (no queda saldo).';
      } else {
        previewRevert.textContent = '';
      }
    }
    newInput.addEventListener('input', refreshPreview);
    refreshPreview();

    return el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-[12px] text-ink-700 leading-relaxed' }, [
        `Corregir el peso seco de entrada a Punto Final del bache `,
        el('strong', { class: 'text-navy', text: lot.bache_code || lot.lot_code }),
        `. La conversión y kg verde se recalculan automáticamente. El motivo queda auditado en las notas del bache.`,
      ]),

      // Estado actual
      el('div', { class: 'rounded-lg bg-cream border border-sand p-3 text-[12px] space-y-1' }, [
        el('p', { class: 'eyebrow text-[9px]', text: 'Estado actual' }),
        el('p', { class: 'font-mono' }, [
          `Peso seco registrado: `, el('strong', { text: fmtKg(oldDried) }),
        ]),
        el('p', { class: 'font-mono' }, [
          `Ya salió de bodega (despachos + mezclas): `,
          el('strong', { text: fmtKg(alreadyOut) }),
        ]),
        el('p', { class: 'font-mono' }, [
          `Saldo actual disponible: `,
          el('strong', { class: currentAvail > 0.01 ? 'text-ok' : 'text-ink-300',
            text: fmtKg(currentAvail) }),
        ]),
      ]),

      // Input nuevo
      el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'Peso seco corregido (kg) *' }),
        newInput,
      ]),

      // Preview
      el('div', { class: 'rounded-lg bg-yellow-light border border-yellow p-3 text-[12px] space-y-1',
          style: 'background:#fbf9d3;border-color:#e7e244;' }, [
        el('p', { class: 'eyebrow text-[9px]', text: 'Preview con el cambio' }),
        el('p', { class: 'font-mono' }, [`Verde recalculado: `, previewGreen]),
        el('p', { class: 'font-mono' }, [`Saldo NUEVO en bodega: `, previewAvail]),
        el('p', { class: 'font-mono' }, [`Nueva conversión: `, previewFactor]),
        previewRevert,
        previewWarn,
      ]),

      // Motivo
      el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'Motivo * (mínimo 10 caracteres)' }),
        reasonInput,
      ]),

      // Acciones
      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-action', type: 'button',
          onClick: async (e) => {
            const btn = e.currentTarget;
            const newDried = Number(newInput.value);
            const reason = reasonInput.value.trim();
            if (!Number.isFinite(newDried) || newDried <= 0) {
              toast('Peso seco debe ser > 0', 'warning'); return;
            }
            if (newDried + 0.01 < alreadyOut) {
              toast(`No puede quedar menor que lo ya salido (${fmtKg(alreadyOut)})`, 'error'); return;
            }
            if (reason.length < 10) {
              toast('El motivo debe tener al menos 10 caracteres', 'warning'); return;
            }
            try {
              let declined = false;
              await withBusy(btn, 'Guardando…', async () => {
                const r = await callWithPlausibilityConfirm((override) =>
                  api.lotAdjustDried({
                    lot_id: lot.id,
                    kg_dried_output: newDried,
                    reason,
                    ...(override ? { override_plausibility: true } : {}),
                  }));
                if (r === null) { declined = true; return; }
                const parts = [`Peso seco actualizado: ${fmtKg(newDried)}`];
                if (r.reverted_to_ready) parts.push(`bache → Listo con ${fmtKg(r.new_available_kg)} de saldo`);
                if ((r.orders_reverted_to_in_production || []).length > 0) {
                  parts.push(`${r.orders_reverted_to_in_production.length} pedido(s) → InProduction`);
                }
                toast(parts.join(' · '), 'success', 6000);
              });
              if (declined) return;   // el operario no confirmó — modal sigue abierta
              close({ ok: true });
            } catch (err) {
              toast(err.message || 'Error al ajustar', 'error', 6000);
            }
          },
        }, ['Guardar ajuste']),
      ]),
    ]);
  }, { title: 'Ajustar peso seco de entrada a Punto Final' });
}

// Modal para agregar un ciclo de descanso retroactivamente a un
// bache ya cerrado (Ready). Caso típico: se olvidó registrar el
// descanso durante el proceso.
async function addRestingCycleModal(lot) {
  return openModal(({ close }) => {
    const startDateInput = el('input', { type: 'date', class: 'ctrm-input' });
    const endDateInput   = el('input', { type: 'date', class: 'ctrm-input' });
    const startHumInput  = el('input', {
      type: 'number', step: '0.1', min: '8', max: '40', placeholder: 'Ej: 19',
      class: 'ctrm-input mono',
    });
    const endHumInput = el('input', {
      type: 'number', step: '0.1', min: '8', max: '40', placeholder: 'Ej: 14',
      class: 'ctrm-input mono',
    });
    const endReasonSelect = el('select', { class: 'ctrm-select' }, [
      el('option', { value: 'to_ready', selected: 'true' }, ['Pasó a Listo']),
      el('option', { value: 'back_to_drying' }, ['Volvió a Secado']),
    ]);
    const reasonInput = el('textarea', {
      rows: '3', class: 'ctrm-textarea',
      placeholder: 'Motivo del registro retroactivo — mínimo 10 caracteres · queda en notas del bache',
    });

    // Advertencia reactiva si las fechas no encajan con las etapas
    // del bache
    const warnBox = el('div', { class: 'text-[11px] text-warn' });
    function refreshWarnings() {
      warnBox.textContent = '';
      const sd = startDateInput.value;
      const ed = endDateInput.value;
      const messages = [];
      if (lot.drying_start_date && sd && sd < lot.drying_start_date) {
        messages.push(`⚠ Inicio (${sd}) es antes del secado (${lot.drying_start_date}).`);
      }
      if (lot.ready_date && ed && ed > lot.ready_date) {
        messages.push(`⚠ Fin (${ed}) es después del cierre (${lot.ready_date}).`);
      }
      if (sd && ed && ed <= sd) {
        messages.push('⚠ El fin debe ser posterior al inicio.');
      }
      warnBox.textContent = messages.join('  ');
    }
    startDateInput.addEventListener('input', refreshWarnings);
    endDateInput.addEventListener('input', refreshWarnings);

    return el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-[12px] text-ink-700 leading-relaxed' }, [
        `Agregar un ciclo de descanso al bache `,
        el('strong', { class: 'text-navy', text: lot.bache_code || lot.lot_code }),
        `. El bache sigue en Listo — no cambia peso, status ni fecha de cierre. El motivo queda en las notas.`,
      ]),
      el('div', { class: 'rounded-lg bg-cream border border-sand p-3 text-[11px] text-ink-500 space-y-0.5 font-mono' }, [
        el('p', {}, [`Secado inició: `, el('strong', { text: fmtDate(lot.drying_start_date) })]),
        el('p', {}, [`Bache cerró:  `, el('strong', { text: fmtDate(lot.ready_date) })]),
      ]),

      el('div', { class: 'grid grid-cols-2 gap-3' }, [
        el('div', {}, [
          el('label', { class: 'ctrm-label', text: 'Inicio del descanso *' }),
          startDateInput,
        ]),
        el('div', {}, [
          el('label', { class: 'ctrm-label', text: 'Humedad de entrada (%) *' }),
          startHumInput,
        ]),
      ]),
      el('div', { class: 'grid grid-cols-2 gap-3' }, [
        el('div', {}, [
          el('label', { class: 'ctrm-label', text: 'Fin del descanso *' }),
          endDateInput,
        ]),
        el('div', {}, [
          el('label', { class: 'ctrm-label', text: 'Humedad de salida (%) *' }),
          endHumInput,
        ]),
      ]),
      el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'Motivo del fin *' }),
        endReasonSelect,
      ]),

      warnBox,

      el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'Motivo del registro retroactivo *' }),
        reasonInput,
      ]),

      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-action', type: 'button',
          onClick: async (e) => {
            const btn = e.currentTarget;
            const start_date = startDateInput.value;
            const end_date = endDateInput.value;
            const startHum = Number(startHumInput.value);
            const endHum = Number(endHumInput.value);
            const end_reason = endReasonSelect.value;
            const reason = reasonInput.value.trim();

            if (!start_date || !end_date) { toast('Indica ambas fechas', 'warning'); return; }
            if (end_date <= start_date) { toast('Fin debe ser posterior al inicio', 'warning'); return; }
            if (!Number.isFinite(startHum) || startHum < 8 || startHum > 40) {
              toast('Humedad de entrada 8–40%', 'warning'); return;
            }
            if (!Number.isFinite(endHum) || endHum < 8 || endHum > 40) {
              toast('Humedad de salida 8–40%', 'warning'); return;
            }
            if (reason.length < 10) {
              toast('El motivo debe tener al menos 10 caracteres', 'warning'); return;
            }
            try {
              await withBusy(btn, 'Guardando…', async () => {
                const r = await api.lotAddRestingCycle({
                  lot_id: lot.id,
                  start_date, start_humidity: startHum,
                  end_date, end_humidity: endHum,
                  end_reason, reason,
                });
                const parts = [`Ciclo agregado (nº ${r.cycle.cycle_number})`];
                if (r.warnings && r.warnings.length > 0) {
                  parts.push(`con ${r.warnings.length} aviso(s)`);
                }
                toast(parts.join(' · '), 'success', 5000);
              });
              close({ ok: true });
            } catch (err) {
              toast(err.message || 'Error al agregar ciclo', 'error', 6000);
            }
          },
        }, ['Agregar ciclo']),
      ]),
    ]);
  }, { title: 'Agregar ciclo de descanso retroactivo' });
}
