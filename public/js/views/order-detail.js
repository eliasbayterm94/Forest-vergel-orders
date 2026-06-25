// Detalle compartido de un pedido (`/pedido?id=<uuid>`). La ven
// tanto Forest como Finca (y admin). Muestra:
//   · Header con status, fecha de entrega, código y cliente
//   · Métricas: Aceptado · Asignado · Despachado · Pendiente
//   · Tabla de asignaciones (bache, status, kg, despacho si aplica)
//   · Tabla de despachos que cubrieron el pedido
//   · Comentario de Forest si lo tiene
//   · Botón "Cerrar pedido" manual (motivo obligatorio), para
//     casos donde el flujo automático (maybeCompleteOrder al
//     despachar lotes asignados) no disparó.

import { el, clear } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { openModal, confirmModal } from '../ui/modal.js';
import { fmtKg, fmtDate, fmtIntensity, statusLabel, statusPillKind, relDate } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { currentQuery, navigate } from '../router.js';

const CLOSEABLE = new Set(['Accepted', 'PartiallyAccepted', 'InProduction']);

export async function orderDetailView({ session }) {
  const id = currentQuery().get('id');
  if (!id) {
    return chrome(el('div', { class: 'p-6' }, [
      el('p', { class: 'text-[13px] text-ink-700', text: 'Falta el id del pedido en la URL.' }),
    ]));
  }

  const [ordersRes, lotsRes, shipsRes] = await Promise.all([
    api.ordersList({}),
    api.lotsList({}),
    api.shipmentsList(),
  ]);
  const order = (ordersRes.orders || []).find((o) => o.id === id);
  if (!order) {
    return chrome(el('div', { class: 'p-6' }, [
      el('p', { class: 'text-[13px] text-ink-700', text: `Pedido ${id.slice(0, 8)}… no encontrado.` }),
      el('button', {
        class: 'ctrm-btn ctrm-btn-soft mt-3', type: 'button',
        onClick: () => history.back(),
      }, ['← Volver']),
    ]));
  }
  const today = ordersRes.today || new Date().toISOString().slice(0, 10);
  const allLots = lotsRes.lots || [];
  const shipments = shipsRes.shipments || [];

  const root = el('div', {});

  async function reload() {
    const [r1, r2] = await Promise.all([api.ordersList({}), api.shipmentsList()]);
    const fresh = (r1.orders || []).find((o) => o.id === id);
    if (fresh) Object.assign(order, fresh);
    // shipments tampoco cambian normalmente; pero refrescamos por si cancelaron una línea
    redraw(fresh, r2.shipments || shipments, allLots);
  }

  function redraw(o, ships, lots) {
    clear(root);
    // Asignaciones del pedido: cruzamos lots[].assignments
    const assignments = [];
    for (const lot of lots) {
      for (const a of (lot.assignments || [])) {
        if (a.demand_order_id !== o.id) continue;
        // Despachos que llevaron ese bache
        const lotShipments = [];
        for (const s of ships) {
          for (const slot of (s.lots || [])) {
            if (slot.id !== lot.id) continue;
            // Sumar kg verde de este lote en ese despacho que apuntan al pedido
            let kgFromThisShipToOrder = 0;
            for (const sa of (slot.assignments || [])) {
              if (sa.order && sa.order.id === o.id) {
                kgFromThisShipToOrder += Number(sa.kg_green_allocated || 0);
              }
            }
            lotShipments.push({
              shipment_id: s.id,
              shipment_code: s.shipment_code,
              shipment_date: s.shipment_date,
              kg_green: kgFromThisShipToOrder || Number(a.kg_green_allocated || 0),
            });
          }
        }
        assignments.push({
          assignment_id: a.id,
          lot_id: lot.id,
          bache_code: lot.bache_code || lot.blend_code || lot.lot_code,
          lot_status: lot.status,
          process_type: lot.process_type,
          factor_rendimiento: lot.factor_rendimiento,
          kg_green_allocated: Number(a.kg_green_allocated || 0),
          shipments: lotShipments,
        });
      }
    }

    // Despachos que cubrieron el pedido (deduplicado por shipment_id)
    const shipmentsCovering = new Map();
    for (const a of assignments) {
      for (const s of a.shipments) {
        const cur = shipmentsCovering.get(s.shipment_id) || {
          shipment_id: s.shipment_id,
          shipment_code: s.shipment_code,
          shipment_date: s.shipment_date,
          kg_green: 0,
          bache_codes: [],
        };
        cur.kg_green += s.kg_green;
        cur.bache_codes.push(a.bache_code);
        shipmentsCovering.set(s.shipment_id, cur);
      }
    }
    const coveringList = [...shipmentsCovering.values()]
      .sort((x, y) => (y.shipment_date || '').localeCompare(x.shipment_date || ''));

    // Métricas
    const accepted = Number(o.kg_green_accepted || 0);
    const required = Number(o.kg_green_required || 0);
    const assignedTotal = assignments.reduce((s, a) => s + a.kg_green_allocated, 0);
    const shippedTotal = assignments
      .filter((a) => a.lot_status === 'Delivered')
      .reduce((s, a) => s + a.kg_green_allocated, 0);
    const pending = Math.max(0, accepted - assignedTotal);
    const coverPct = accepted > 0 ? Math.min(100, (assignedTotal / accepted) * 100) : 0;
    const shipPct  = accepted > 0 ? Math.min(100, (shippedTotal / accepted) * 100) : 0;

    const canClose = CLOSEABLE.has(o.status);
    const closeBtn = canClose
      ? el('button', {
          class: 'ctrm-btn ctrm-btn-danger ctrm-btn-sm',
          onClick: () => onCloseOrder(o),
        }, ['× Cerrar pedido'])
      : null;
    const editBtn = o.status === 'Pending' || canClose
      ? el('button', {
          class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
          onClick: () => navigateToEdit(o),
        }, ['Editar'])
      : null;

    root.append(el('div', {}, [
      // ── Breadcrumb ──
      el('div', { class: 'mb-2' }, [
        el('button', {
          type: 'button',
          class: 'text-[11px] font-display uppercase tracking-eyebrow text-ink-500 hover:text-navy inline-flex items-center gap-1',
          style: 'background:none;border:none;padding:0;cursor:pointer;',
          onClick: () => history.back(),
        }, ['← Volver']),
      ]),

      // ── Hero ──
      el('div', { class: 'ctrm-card ctrm-card-pad mb-4' }, [
        el('div', { class: 'flex flex-col md:flex-row md:items-center justify-between gap-3 mb-3' }, [
          el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
            el('span', { class: 'ctrm-code text-[14px]', text: o.order_code || '—' }),
            el('span', { class: 'font-display font-semibold text-navy text-[15px]', text: o.reference_name || '—' }),
            el('span', { class: `ctrm-pill ${statusPillKind(o.status)}`, text: statusLabel(o.status) }),
            o.order_type ? el('span', { class: 'ctrm-pill dark text-[10px]', text: o.order_type }) : null,
          ]),
          el('div', { class: 'flex items-center gap-2' }, [editBtn, closeBtn]),
        ]),
        // Meta strip
        el('div', { class: 'flex flex-wrap text-[12px] text-ink-500 gap-x-4 gap-y-1 font-mono mb-3' }, [
          o.client_name ? metaPair('Cliente', o.client_name) : null,
          o.regions && o.regions.length ? metaPair('Regiones', o.regions.join(' · ')) : null,
          o.contract_code ? metaPair('Contrato', o.contract_code) : null,
          metaPair('Proceso', o.process_type),
          metaPair('Aspecto', o.physical_aspect),
          o.intensity ? metaPair('Intensidad', fmtIntensity(o.intensity)) : null,
          o.max_delivery_date ? metaPair('Entrega', `${fmtDate(o.max_delivery_date)} · ${relDate(o.max_delivery_date)}`) : null,
        ]),

        // Métricas grandes
        el('div', { class: 'grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3' }, [
          metricCard('Aceptado',   fmtKg(accepted),       `requeridos: ${fmtKg(required)}`),
          metricCard('Asignado',   fmtKg(assignedTotal),  `${assignments.length} asignación(es)`, assignedTotal >= accepted - 0.01 ? 'ok' : 'warn'),
          metricCard('Despachado', fmtKg(shippedTotal),   coveringList.length > 0 ? `${coveringList.length} despacho(s)` : 'aún no sale', shippedTotal > 0 ? 'ok' : null),
          metricCard('Pendiente',  fmtKg(pending),        pending > 0 ? 'sin asignar' : 'cubierto', pending > 0 ? 'warn' : 'ok'),
        ]),

        // Barras de cobertura
        el('div', { class: 'space-y-2' }, [
          coverageBar('Cobertura (asignado)', coverPct, '#3a6f4a'),
          coverageBar('Despachado',          shipPct,  '#1a3a5c'),
        ]),
      ]),

      // ── Asignaciones ──
      el('div', { class: 'ctrm-card overflow-hidden mb-4' }, [
        el('div', { class: 'px-3 py-2 bg-cream border-b border-sand' }, [
          el('p', { class: 'eyebrow text-[10px]', text: `Asignaciones (${assignments.length})` }),
        ]),
        assignments.length === 0
          ? el('p', { class: 'px-3 py-4 text-[12px] text-ink-300 italic',
              text: 'Este pedido no tiene baches asignados todavía.' })
          : el('div', { class: 'overflow-x-auto' }, [
              el('table', { class: 'w-full text-[12px]' }, [
                el('thead', {}, [el('tr', { class: 'text-ink-500 uppercase tracking-eyebrow text-[10px] bg-cream' }, [
                  th2('Bache'),
                  th2('Status'),
                  th2('Proceso'),
                  th2('kg verde', 'text-right'),
                  th2('Factor', 'text-right'),
                  th2('Despacho(s)'),
                ])]),
                el('tbody', {}, assignments.map((a) => el('tr', { class: 'border-t border-sand hover:bg-cream' }, [
                  el('td', { class: 'px-3 py-2' }, [
                    el('button', {
                      type: 'button',
                      class: 'font-mono font-semibold text-navy hover:underline',
                      style: 'background:none;border:none;padding:0;cursor:pointer;',
                      onClick: () => navigate(`/finca/bache?id=${a.lot_id}`),
                      text: a.bache_code,
                    }),
                  ]),
                  el('td', { class: 'px-3 py-2' }, [
                    el('span', { class: `ctrm-pill text-[10px] ${statusPillKind(a.lot_status)}`, text: statusLabel(a.lot_status) }),
                  ]),
                  el('td', { class: 'px-3 py-2 text-[11px]', text: a.process_type || '—' }),
                  el('td', { class: 'px-3 py-2 text-right font-mono font-bold', text: fmtKg(a.kg_green_allocated) }),
                  el('td', { class: 'px-3 py-2 text-right font-mono text-ink-500', text: a.factor_rendimiento != null ? String(a.factor_rendimiento) : '—' }),
                  el('td', { class: 'px-3 py-2' }, [
                    a.shipments.length === 0
                      ? el('span', { class: 'text-[11px] text-ink-300 italic', text: '— sin despachar' })
                      : el('div', { class: 'flex flex-wrap gap-1' },
                          a.shipments.map((s) => el('button', {
                            type: 'button',
                            class: 'ctrm-pill text-[10px] cursor-pointer hover:opacity-80',
                            style: 'background:#dbeafe;color:#1a3a5c;',
                            title: `${fmtDate(s.shipment_date)}`,
                            onClick: () => navigate(`/finca/despachos?focus=${s.shipment_id}`),
                            text: s.shipment_code,
                          }))),
                  ]),
                ]))),
              ]),
            ]),
      ]),

      // ── Despachos que cubrieron el pedido ──
      coveringList.length > 0 ? el('div', { class: 'ctrm-card overflow-hidden mb-4' }, [
        el('div', { class: 'px-3 py-2 bg-cream border-b border-sand' }, [
          el('p', { class: 'eyebrow text-[10px]', text: `Despachos que cubrieron este pedido (${coveringList.length})` }),
        ]),
        el('div', { class: 'overflow-x-auto' }, [
          el('table', { class: 'w-full text-[12px]' }, [
            el('thead', {}, [el('tr', { class: 'text-ink-500 uppercase tracking-eyebrow text-[10px] bg-cream' }, [
              th2('Despacho'),
              th2('Fecha'),
              th2('Baches'),
              th2('kg verde para este pedido', 'text-right'),
            ])]),
            el('tbody', {}, coveringList.map((s) => el('tr', { class: 'border-t border-sand hover:bg-cream' }, [
              el('td', { class: 'px-3 py-2' }, [
                el('button', {
                  type: 'button',
                  class: 'ctrm-code text-[11px] cursor-pointer hover:underline',
                  style: 'background:none;border:none;padding:0;',
                  onClick: () => navigate(`/finca/despachos?focus=${s.shipment_id}`),
                  text: s.shipment_code,
                }),
              ]),
              el('td', { class: 'px-3 py-2 font-mono text-[11px]', text: fmtDate(s.shipment_date) }),
              el('td', { class: 'px-3 py-2 text-[11px] font-mono text-ink-700', text: s.bache_codes.join(' · ') }),
              el('td', { class: 'px-3 py-2 text-right font-mono font-bold', text: fmtKg(s.kg_green) }),
            ]))),
          ]),
        ]),
      ]) : null,

      // ── Comentario de Forest + datos extra ──
      (o.comments || o.completed_at) ? el('div', { class: 'ctrm-card ctrm-card-pad mb-4' }, [
        o.comments
          ? el('div', { class: 'mb-3' }, [
              el('p', { class: 'eyebrow text-[10px] mb-1', text: 'Comentario de Forest / Historial' }),
              el('p', { class: 'text-[12px] text-ink-700 whitespace-pre-line', text: o.comments }),
            ])
          : null,
        o.completed_at
          ? el('p', { class: 'text-[11px] text-ok font-mono',
              text: `Completado el ${fmtDate(String(o.completed_at).slice(0, 10))}` })
          : null,
      ]) : null,
    ]));
  }

  async function onCloseOrder(o) {
    const reasonInput = el('textarea', {
      rows: '3', class: 'ctrm-textarea w-full',
      placeholder: 'Motivo del cierre manual…',
    });
    const out = await openModal(({ close }) => el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-[12px] text-ink-700 leading-relaxed' }, [
        `Cerrar el pedido `,
        el('strong', { class: 'text-navy', text: o.order_code || o.id.slice(0, 8) }),
        ` como `, el('strong', { class: 'text-ok', text: 'Completed' }),
        `. El motivo queda en el comentario del pedido.`,
      ]),
      el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'Motivo *' }),
        reasonInput,
      ]),
      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { type: 'button', class: 'ctrm-btn ctrm-btn-ghost', onClick: () => close(null) }, ['Cancelar']),
        el('button', {
          type: 'button', class: 'ctrm-btn ctrm-btn-action',
          onClick: () => {
            const reason = reasonInput.value.trim();
            if (!reason) { toast('Indica el motivo del cierre', 'warning'); return; }
            close({ reason });
          },
        }, ['Cerrar pedido']),
      ]),
    ]), { title: 'Cerrar pedido manualmente' });

    if (!out) return;
    try {
      await api.orderMarkComplete({ order_id: o.id, reason: out.reason });
      toast('Pedido cerrado', 'success');
      reload();
    } catch (e) { toast(e.message || 'Error al cerrar pedido', 'error', 6000); }
  }

  function navigateToEdit(o) {
    // Forest edita desde el dashboard; Finca puede editar campos
    // limitados desde el inbox. Para no inventar UI nueva, mandamos
    // a Forest al dashboard con focus, y a Finca a su inbox.
    if (session && session.role === 'forest') navigate(`/forest/dashboard?section=inflight&focus=${o.id}`);
    else navigate('/finca/inbox');
  }

  redraw(order, shipments, allLots);
  return chrome(el('div', {}, [
    pageTitle('Detalle del pedido', order.order_code || order.id.slice(0, 8)),
    root,
  ]));
}

function metaPair(label, value) {
  return el('span', { class: 'inline-flex items-baseline gap-1' }, [
    el('span', { class: 'text-ink-300 uppercase tracking-loose text-[10px] font-sans font-semibold', text: label }),
    el('strong', { class: 'text-ink-700 font-mono', text: String(value) }),
  ]);
}

function metricCard(label, value, hint, kind) {
  const valClass = kind ? `stat-val ${kind}` : 'stat-val';
  return el('div', { class: 'stat-card' }, [
    el('p', { class: 'stat-label', text: label }),
    el('p', { class: valClass, text: String(value) }),
    el('p', { class: 'stat-sub', text: hint || '' }),
  ]);
}

function coverageBar(label, pct, color) {
  return el('div', {}, [
    el('div', { class: 'flex items-baseline justify-between text-[11px] text-ink-500 mb-0.5' }, [
      el('span', { text: label }),
      el('strong', { class: 'font-mono text-ink-700', text: `${Math.round(pct)}%` }),
    ]),
    el('div', { class: 'h-2 rounded-full bg-sand overflow-hidden' }, [
      el('div', { class: 'h-full', style: `width:${pct}%;background:${color};` }),
    ]),
  ]);
}

function th2(label, extra = '') {
  return el('th', { class: `px-3 py-2 text-left ${extra}`, text: label });
}
