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
import { NEXT_TRANSITIONS, advanceStatus as advanceStatusShared } from './_bache-actions.js';

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

    root.append(
      // ── Breadcrumb ──
      el('div', { class: 'mb-2' }, [
        el('button', {
          type: 'button',
          class: 'text-[11px] font-display uppercase tracking-eyebrow text-ink-500 hover:text-navy inline-flex items-center gap-1',
          style: 'background:none;border:none;padding:0;cursor:pointer;',
          onClick: () => navigate('/finca/lots'),
        }, ['← Producción']),
      ]),

      // ── Header con acciones ──
      el('div', { class: 'ctrm-card ctrm-card-pad mb-4' }, [
        el('div', { class: 'flex flex-wrap items-start justify-between gap-3 mb-2' }, [
          el('div', { class: 'flex items-center gap-2 flex-wrap min-w-0' }, [
            el('span', { class: 'ctrm-code text-[13px]', text: lot.bache_code || lot.lot_code }),
            (lot.bache_code && lot.bache_code !== lot.lot_code)
              ? el('span', { class: 'text-[10px] text-ink-300 font-mono', text: lot.lot_code })
              : null,
            lot.reference_name
              ? el('span', { class: 'font-display font-semibold text-navy text-[14px]', text: lot.reference_name })
              : el('span', { class: 'font-display italic text-ink-300 text-[13px]', text: 'Sin referencia' }),
            el('span', { class: `ctrm-pill ${statusPillKind(lot.status)}`, text: statusLabel(lot.status) }),
            ...(lot.status === 'Drying'
              ? (lot.drying_locations || []).map((loc) =>
                  el('span', { class: 'ctrm-pill text-[10px]',
                    style: 'background:#dde7ee;color:#1a3a5c;', text: loc }))
              : []),
            lot.status === 'Resting' && lot.resting_humidity != null
              ? el('span', { class: 'ctrm-pill', style: 'background:#fbe6c2;color:#8a5100;',
                  text: `Humedad ${lot.resting_humidity}%` })
              : null,
            (lot.resting_cycles_count || 0) > 1
              ? el('span', { class: 'ctrm-pill', style: 'background:#1a3a5c;color:#fff;',
                  text: `Descansos: ${lot.resting_cycles_count}` })
              : null,
          ]),
          el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
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
            isLocked
              ? el('span', { class: 'text-[11px] italic text-ink-300', text: 'Bache despachado · sólo lectura' })
              : null,
          ]),
        ]),
        el('p', { class: 'text-[11px] text-ink-500 font-mono', text:
          `${lot.process_type || '—'}` +
          (lot.processing_stage ? ` · stage ${lot.processing_stage}` : '') +
          (lot.client_name ? ` · ${lot.client_name}` : '') }),
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

      // ── Historial ──
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
                  el('span', { class: 'ctrm-code text-[10px]', text: o.order_code || '—' }),
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
    );
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

// ── Historial ──────────────────────────────────────────────────────
// Reconstruye los eventos desde los timestamps + ciclos de descanso.
// Cada evento muestra fecha + título + detalle, y un botón ✎ para
// editar SÓLO la fecha (lo demás se edita en sus respectivos flows).
function renderHistory(lot, isLocked, reload) {
  const events = [];

  // 1. Inicio de fermentación (siempre presente).
  if (lot.start_date) {
    events.push({
      kind: 'start',
      date: lot.start_date,
      title: 'Fermentación iniciada',
      detail: `${stageLabel(lot.processing_stage)} · ${lot.kg_input_initial != null ? fmtKg(lot.kg_input_initial) : '—'}`,
      editable: !isLocked,
      onEditDate: async (newDate) => {
        await api.lotUpdate({ lot_id: lot.id, fields: { start_date: newDate } });
      },
    });
  }

  // 2. Entrada a Secado.
  if (lot.drying_start_date) {
    events.push({
      kind: 'drying',
      date: lot.drying_start_date,
      title: '→ Secado',
      detail: (lot.drying_locations || []).length > 0
        ? `Marquesinas: ${(lot.drying_locations || []).join(' · ')}`
        : 'Sin marquesinas registradas',
      editable: !isLocked,
      onEditDate: async (newDate) => {
        await api.lotUpdate({ lot_id: lot.id, fields: { drying_start_date: newDate } });
      },
    });
  }

  // 3. Ciclos de descanso (entrada + salida cuando existe).
  const cycles = (lot.resting_cycles || []).slice().sort((a, b) => a.cycle_number - b.cycle_number);
  for (const c of cycles) {
    events.push({
      kind: 'resting-in',
      date: c.start_date,
      title: `→ Descanso · ciclo ${c.cycle_number}`,
      detail: `Humedad entrada: ${c.start_humidity}%${maxDaysHint(c.start_humidity)}`,
      editable: !isLocked,
      onEditDate: async (newDate) => {
        await api.lotRestingCycleUpdate({ cycle_id: c.id, fields: { start_date: newDate } });
      },
    });
    if (c.end_date) {
      const action = c.end_reason === 'back_to_drying' ? '← Volver a Secado' : '→ Listo';
      events.push({
        kind: 'resting-out',
        date: c.end_date,
        title: action,
        detail: `Humedad salida: ${c.end_humidity != null ? c.end_humidity + '%' : '—'}`,
        editable: !isLocked,
        onEditDate: async (newDate) => {
          await api.lotRestingCycleUpdate({ cycle_id: c.id, fields: { end_date: newDate } });
        },
      });
    }
  }

  // 4. Ready (cuando la transición no pasó por descanso, agregamos un
  // evento explícito; si pasó por descanso, ya se cubrió arriba con el
  // ciclo cerrado con end_reason='to_ready').
  const lastCycle = cycles[cycles.length - 1];
  const readyFromResting = lastCycle && lastCycle.end_reason === 'to_ready' && lastCycle.end_date === lot.ready_date;
  if (lot.ready_date && !readyFromResting) {
    events.push({
      kind: 'ready',
      date: lot.ready_date,
      title: '→ Listo',
      detail: [
        lot.kg_dried_output != null ? `Seco ${fmtKg(lot.kg_dried_output)}` : null,
        lot.factor_rendimiento != null ? `Factor ${lot.factor_rendimiento}` : null,
        lot.kg_green_actual != null ? `Verde ${fmtKg(lot.kg_green_actual)}` : null,
      ].filter(Boolean).join(' · '),
      editable: !isLocked,
      onEditDate: async (newDate) => {
        await api.lotUpdate({ lot_id: lot.id, fields: { ready_date: newDate } });
      },
    });
  } else if (lot.ready_date && readyFromResting) {
    // Enriquecer el último evento (Ready desde descanso) con kg/factor.
    const ev = events[events.length - 1];
    const yieldDetail = [
      lot.kg_dried_output != null ? `Seco ${fmtKg(lot.kg_dried_output)}` : null,
      lot.factor_rendimiento != null ? `Factor ${lot.factor_rendimiento}` : null,
      lot.kg_green_actual != null ? `Verde ${fmtKg(lot.kg_green_actual)}` : null,
    ].filter(Boolean).join(' · ');
    if (yieldDetail) ev.detail = `${ev.detail}\n${yieldDetail}`;
  }

  // 5. Delivered.
  if (lot.delivered_date) {
    events.push({
      kind: 'delivered',
      date: lot.delivered_date,
      title: '→ Despachado',
      detail: '',
      editable: false,
    });
  }

  // Render: timeline vertical con bullets + línea.
  return el('div', { class: 'space-y-3' }, events.map((ev, i) => {
    const isLast = i === events.length - 1;
    return el('div', { class: 'flex gap-3' }, [
      el('div', { class: 'flex flex-col items-center pt-1 shrink-0' }, [
        el('span', { class: 'inline-block w-2 h-2 rounded-full bg-navy' }),
        !isLast ? el('span', { class: 'flex-1 w-px bg-sand mt-1', style: 'min-height:24px;' }) : null,
      ]),
      el('div', { class: 'flex-1 min-w-0 pb-2' }, [
        el('div', { class: 'flex items-baseline justify-between gap-2 flex-wrap' }, [
          el('div', { class: 'flex items-baseline gap-2 flex-wrap' }, [
            el('span', { class: 'font-mono text-[11px] text-ink-500', text: fmtDate(ev.date) }),
            el('span', { class: 'font-display text-[13px] text-navy font-semibold', text: ev.title }),
          ]),
          ev.editable
            ? el('button', {
                type: 'button',
                class: 'text-[11px] text-ink-300 hover:text-navy',
                style: 'background:none;border:none;padding:2px 6px;cursor:pointer;',
                title: 'Editar fecha',
                onClick: () => editEventDate(ev, reload),
              }, ['✎'])
            : null,
        ]),
        ev.detail
          ? el('p', { class: 'text-[11px] text-ink-500 font-mono whitespace-pre-line mt-0.5', text: ev.detail })
          : null,
      ]),
    ]);
  }));
}

function editEventDate(ev, reload) {
  openModal(({ close }) => {
    const dateInput = el('input', {
      type: 'date',
      value: ev.date || '',
      class: 'ctrm-input',
    });
    return el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-[12px] text-ink-700' }, [
        `Editar fecha de `, el('strong', { class: 'text-navy', text: ev.title }),
      ]),
      el('label', { class: 'ctrm-label', text: 'Nueva fecha' }),
      dateInput,
      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-ghost', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          class: 'ctrm-btn ctrm-btn-primary',
          type: 'button',
          onClick: async (e) => {
            const btn = e.currentTarget;
            const v = dateInput.value;
            if (!v) { toast('Selecciona una fecha', 'warning'); return; }
            if (v === ev.date) { close(null); return; }
            try {
              await withBusy(btn, 'Guardando…', () => ev.onEditDate(v));
              toast('Fecha actualizada', 'success');
              close({ ok: true });
              reload();
            } catch (err) {
              console.error('editEventDate failed', err);
              toast(err.message || 'Error al guardar', 'error', 6000);
            }
          },
        }, ['Guardar']),
      ]),
    ]);
  }, { title: 'Editar fecha' });
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
