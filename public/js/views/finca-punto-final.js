// Punto Final — lotes Ready en bodega listos para generar despacho.
// Tabla con filtros y KPIs de rotacion (dias desde Ready y desde el
// inicio del proceso). Permite seleccionar 1..N lotes y "Generar
// despacho" que abre el modal de /finca/despachos con esos preselects.

import { el, clear } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { fmtKg, fmtDate } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { navigate } from '../router.js';
import { renderFilterButton } from '../ui/filters-sheet.js';
import { emptyStateCard } from '../ui/empty.js';
import { openModal, confirmModal } from '../ui/modal.js';
import { generateInventoryPdf } from '../ui/pdf.js';

export async function fincaPuntoFinalView() {
  const [lotsRes, ordersRes] = await Promise.all([
    api.lotsList({ status: 'Ready' }),
    api.ordersList({}),
  ]);
  const lots = lotsRes.lots || [];
  const allOrders = ordersRes.orders || [];
  const ordersById = new Map(allOrders.map((o) => [o.id, o]));
  const today = ordersRes.today || new Date().toISOString().slice(0, 10);

  // Enriquecer cada lote: kg verde efectivo, dias en bodega (ready_date)
  // y dias desde proceso (start_date). Tambien collectar pedidos
  // asignados con su cliente / region / contrato.
  const enrichedAll = lots.map((l) => {
    const kgVerde = Number(l.kg_green_actual ?? l.kg_green_expected ?? 0);
    const daysInWarehouse = l.ready_date ? daysBetween(l.ready_date, today) : null;
    const daysSinceStart  = l.start_date ? daysBetween(l.start_date, today) : null;
    const assignments = (l.assignments || []).map((a) => {
      const o = ordersById.get(a.demand_order_id) || a.order || {};
      return {
        order_id: a.demand_order_id,
        order_code: o.order_code || null,
        client_name: o.client_name || null,
        contract_code: o.contract_code || null,
        regions: o.regions || [],
        kg_green_allocated: Number(a.kg_green_allocated || 0),
      };
    });
    return {
      ...l,
      kg_verde: kgVerde,
      days_in_warehouse: daysInWarehouse,
      days_since_start:  daysSinceStart,
      enriched_assignments: assignments,
      // helpers de filtros
      _client_names:  [...new Set(assignments.map((a) => a.client_name).filter(Boolean))],
      _order_codes:   [...new Set(assignments.map((a) => a.order_code).filter(Boolean))],
      _regions:       [...new Set(assignments.flatMap((a) => a.regions || []))],
      _variety_names: (l.varieties || []).map((v) => v.name),
    };
  });

  // Filtrar lotes ya totalmente consumidos (kg seco disponible = 0
  // por estar enteros en mezclas y/o despachados). Se cuentan aparte
  // para mostrar un aviso.
  const enriched = enrichedAll.filter((l) =>
    l.kg_dried_available == null || Number(l.kg_dried_available) > 0.01);
  const hiddenConsumed = enrichedAll.length - enriched.length;

  // ── Orden por columna (toggle asc/desc al clickear el header) ──
  let sortKey = 'days_in_warehouse';
  let sortDir = 'desc';
  const SORT_COLS = {
    bache:        { label: 'Bache',         getter: (l) => (l.bache_code || l.blend_code || l.lot_code || '').toLowerCase() },
    reference:    { label: 'Referencia',    getter: (l) => (l.reference_name || '').toLowerCase() },
    process:      { label: 'Proceso',       getter: (l) => l.process_type || '' },
    varieties:    { label: 'Variedades',    getter: (l) => (l._variety_names || []).join(',').toLowerCase() },
    kg_seco:      { label: 'kg seco',       getter: (l) => Number(l.kg_dried_output || 0) },
    kg_verde:     { label: 'kg verde',      getter: (l) => Number(l.kg_verde || 0) },
    asignado:     { label: 'Asignado v.',   getter: (l) => Number(l.kg_green_assigned || 0) },
    disponible:   { label: 'Disponible v.', getter: (l) => Number(l.kg_green_available || 0) },
    conversion:   { label: 'Conversión',    getter: (l) => Number(l.conversion_factor || 0) },
    humedad:      { label: 'Humedad',       getter: (l) => l.final_humidity == null ? -1 : Number(l.final_humidity) },
    parciales:    { label: 'Parciales',     getter: (l) => (l.partials || []).length },
    days_in_warehouse: { label: 'Días bodega',  getter: (l) => l.days_in_warehouse == null ? -1 : Number(l.days_in_warehouse) },
    days_proceso: { label: 'Días proceso',  getter: (l) => l.days_since_start == null ? -1 : Number(l.days_since_start) },
    ready_date:   { label: 'Listo desde',   getter: (l) => l.ready_date || '' },
    asignaciones: { label: 'Pedido / Cliente', getter: (l) => (l.enriched_assignments?.length || 0) + (l.purchases?.length || 0) },
    region:       { label: 'Región',        getter: (l) => (l._regions || [])[0] || '' },
  };

  function applySort(arr) {
    const col = SORT_COLS[sortKey];
    if (!col) return arr;
    const dir = sortDir === 'asc' ? 1 : -1;
    return arr.slice().sort((a, b) => {
      const va = col.getter(a); const vb = col.getter(b);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }

  function setSort(key) {
    if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    else { sortKey = key; sortDir = 'asc'; }
    redraw();
  }

  function sortHeader(label, key, extraClass = '') {
    const isActive = sortKey === key;
    const arrow = isActive ? (sortDir === 'asc' ? '▲' : '▼') : '';
    return el('th', {
      class: `cursor-pointer select-none hover:text-navy ${extraClass}`,
      title: 'Ordenar por ' + label,
      onClick: () => setSort(key),
    }, [
      el('span', {}, [label]),
      isActive ? el('span', { class: 'ml-1 text-navy text-[10px]', text: arrow }) : null,
    ]);
  }

  // ── Filtros ──
  let sheetValues = {};
  let dateFromValue = '';
  let dateToValue = '';
  const selected = new Set();
  const expanded = new Set();   // lot_ids con sus parciales desplegados
  // En móvil la tabla se apila como tarjetas (responsive-stack). Este
  // toggle permite verla como tabla real con scroll horizontal.
  let mobileTableMode = false;

  const filters = [
    { key: 'variety', label: 'Variedad', multi: true,
      options: [...new Set(enriched.flatMap((l) => l._variety_names))].sort(),
      getter: () => '' },
    { key: 'process', label: 'Proceso', multi: true,
      options: ['Natural', 'Honey', 'Lavado'],
      getter: (l) => l.process_type || '' },
    { key: 'order', label: 'Pedido', multi: true,
      options: [...new Set(enriched.flatMap((l) => l._order_codes))].sort(),
      getter: () => '' },
    { key: 'client', label: 'Cliente', multi: true,
      options: [...new Set(enriched.flatMap((l) => l._client_names))].sort(),
      getter: () => '' },
    { key: 'region', label: 'Región', multi: true,
      options: [...new Set(enriched.flatMap((l) => l._regions))].sort(),
      getter: () => '' },
  ];

  function passes(l) {
    for (const f of filters) {
      const v = sheetValues[f.key];
      if (!v || v.length === 0) continue;
      if (f.key === 'variety')  { if (!l._variety_names.some((n) => v.includes(n))) return false; continue; }
      if (f.key === 'process')  { if (!v.includes(l.process_type)) return false; continue; }
      if (f.key === 'order')    { if (!l._order_codes.some((c) => v.includes(c))) return false; continue; }
      if (f.key === 'client')   { if (!l._client_names.some((c) => v.includes(c))) return false; continue; }
      if (f.key === 'region')   { if (!l._regions.some((r) => v.includes(r))) return false; continue; }
    }
    if (dateFromValue && (l.ready_date || '') < dateFromValue) return false;
    if (dateToValue   && (l.ready_date || '') > dateToValue)   return false;
    return true;
  }

  const root = el('div', {});

  function bucketCount(items, min, max) {
    return items.filter((l) => {
      const d = l.days_in_warehouse;
      if (d == null) return false;
      if (max == null) return d > min;
      return d >= min && d <= max;
    }).length;
  }

  function redraw() {
    clear(root);
    const shown = applySort(enriched.filter(passes));
    const totalKg     = shown.reduce((s, l) => s + Number(l.kg_verde || 0), 0);
    const totalSeco   = shown.reduce((s, l) => s + Number(l.kg_dried_output || 0), 0);
    const uniqueOrders = new Set();
    for (const l of shown) for (const a of l.enriched_assignments) if (a.order_id) uniqueOrders.add(a.order_id);

    // Por proceso (Natural / Honey / Lavado): kg seco + kg verde.
    const byProcess = { Natural: { seco: 0, verde: 0 }, Honey: { seco: 0, verde: 0 }, Lavado: { seco: 0, verde: 0 } };
    for (const l of shown) {
      const p = byProcess[l.process_type];
      if (!p) continue;
      p.seco  += Number(l.kg_dried_output || 0);
      p.verde += Number(l.kg_verde || 0);
    }

    const b_0_10  = bucketCount(shown, 0, 10);
    const b_11_20 = bucketCount(shown, 11, 20);
    const b_21    = bucketCount(shown, 20, null);

    const fb = renderFilterButton({
      filters,
      values: sheetValues,
      onChange: (v) => { sheetValues = v; redraw(); },
    });
    const dateFromInput = el('input', {
      type: 'date', value: dateFromValue, class: 'ctrm-input text-[12px]',
      title: 'Entrada a Punto Final desde',
      onInput: (e) => { dateFromValue = e.target.value; redraw(); },
    });
    const dateToInput = el('input', {
      type: 'date', value: dateToValue, class: 'ctrm-input text-[12px]',
      title: 'Entrada a Punto Final hasta',
      onInput: (e) => { dateToValue = e.target.value; redraw(); },
    });

    const mezclarBtn = el('button', {
      class: 'ctrm-btn ctrm-btn-soft uppercase tracking-eyebrow text-[11px]',
      type: 'button',
      onClick: async () => {
        if (selected.size < 2) {
          toast('Selecciona al menos 2 baches para mezclar', 'warning'); return;
        }
        const sel = enriched.filter((l) => selected.has(l.id));
        const out = await openBlendModal(sel);
        if (out && out.ok) { toast('Mezcla creada', 'success'); navigate('/finca/punto-final'); }
      },
    }, [selected.size >= 2 ? `Mezclar (${selected.size})` : 'Mezclar']);

    const cta = el('div', { class: 'flex items-center gap-2' }, [
      mezclarBtn,
      el('button', {
        class: 'ctrm-btn ctrm-btn-yellow uppercase tracking-eyebrow text-[11px]',
        type: 'button',
        onClick: () => {
          if (selected.size === 0) { toast('Selecciona al menos un lote', 'warning'); return; }
          try {
            sessionStorage.setItem('punto-final-preselect', JSON.stringify([...selected]));
          } catch { /* fallback: nada */ }
          navigate('/finca/despachos');
        },
      }, [selected.size > 0 ? `Generar despacho (${selected.size})` : 'Generar despacho']),
    ]);

    root.append(
      pageTitle('Punto Final', `Lotes en bodega · ${shown.length} de ${enriched.length}`, cta),

      // KPI cards — el kg que muestra el hero es SECO (bodega física).
      el('div', { class: 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-3' }, [
        kpiCard('Lotes',   String(shown.length),   'En bodega'),
        kpiCard('Pedidos', String(uniqueOrders.size), 'Únicos asignados'),
        kpiCard('Seco',    fmtKg(totalSeco),       'Total kg seco'),
        kpiCard('0–10 d',  String(b_0_10),  'Recientes', 'ok'),
        kpiCard('11–20 d', String(b_11_20), 'Atención',  b_11_20 > 0 ? 'warn' : null),
        kpiCard('>20 d',   String(b_21),    'Críticos',  b_21 > 0 ? 'crit' : null),
      ]),

      // Hero por proceso: kg seco grande (lo que está físicamente en
      // bodega) y kg verde esperado como subtítulo. Tres tiles más
      // visuales que la fila compacta anterior.
      el('div', { class: 'grid grid-cols-1 sm:grid-cols-3 gap-2 mb-4' }, [
        ...['Natural', 'Honey', 'Lavado'].map((p) => {
          const v = byProcess[p];
          const color = p === 'Natural' ? '#3a6f4a'
                      : p === 'Honey'   ? '#ddae3e'
                      :                    '#7e9ec1';
          return el('div', { class: 'ctrm-card ctrm-card-pad relative' }, [
            el('div', { class: 'absolute top-0 left-0 right-0 h-1', style: `background:${color};` }),
            el('p', { class: 'eyebrow text-[10px] text-ink-500 mt-1', text: p }),
            el('p', { class: 'font-display text-[22px] font-semibold text-navy mt-0.5' }, [
              fmtKg(v.seco),
              el('span', { class: 'text-[12px] text-ink-500 font-mono ml-1', text: 'kg seco' }),
            ]),
            el('p', { class: 'text-[11px] font-mono text-ink-500 mt-0.5',
              text: `${fmtKg(v.verde)} kg verde esperado` }),
          ]);
        }),
      ]),

      // Filtros + fechas
      el('div', { class: 'mb-3 flex items-center gap-2 flex-wrap' }, [
        fb.el,
        el('span', { class: 'text-[11px] text-ink-500', text: 'Entrada a punto final:' }),
        dateFromInput,
        el('span', { class: 'text-[11px] text-ink-500', text: '→' }),
        dateToInput,
        (dateFromValue || dateToValue) ? el('button', {
          type: 'button', class: 'ctrm-btn ctrm-btn-ghost ctrm-btn-xs',
          onClick: () => { dateFromValue = ''; dateToValue = ''; redraw(); },
        }, ['Limpiar fechas']) : null,
        // Toggle tarjetas/tabla — solo visible en móvil (sm:hidden).
        el('button', {
          type: 'button', class: 'ctrm-btn ctrm-btn-soft ctrm-btn-xs sm:hidden',
          title: 'Alternar entre tarjetas y tabla',
          onClick: () => { mobileTableMode = !mobileTableMode; redraw(); },
        }, [mobileTableMode ? 'Ver tarjetas' : 'Ver tabla']),
        // Descargar inventario como PDF (sobre el set filtrado actual).
        el('button', {
          type: 'button', class: 'ctrm-btn ctrm-btn-soft ctrm-btn-xs ml-auto',
          title: 'Descargar el inventario visible como PDF',
          onClick: () => {
            if (shown.length === 0) { toast('No hay lotes para exportar', 'warning'); return; }
            try { generateInventoryPdf(shown); }
            catch (e) { toast(e.message || 'Error al generar PDF', 'error'); }
          },
        }, ['↓ Inventario PDF']),
      ]),

      // Aviso si hay lotes consumidos ocultos
      hiddenConsumed > 0
        ? el('div', { class: 'mb-2 text-[11px] text-ink-500 italic',
            text: `${hiddenConsumed} lote(s) ya consumidos en mezclas o despachos no se listan (sin kg seco disponible).` })
        : null,

      // Tabla
      shown.length === 0
        ? emptyStateCard({
            title: enriched.length === 0 ? 'Aún no hay lotes en bodega' : 'Sin lotes que coincidan',
            description: enriched.length === 0
              ? 'Cuando finca cierre un bache aparecerá aquí.'
              : 'Ajusta los filtros para ver lotes en bodega.',
          })
        : lotsTable(shown),
    );
  }

  function lotsTable(items) {
    const wrap = el('div', { class: 'overflow-x-auto ctrm-card' });
    const headerCb = el('input', {
      type: 'checkbox',
      class: 'h-4 w-4 accent-navy',
      title: 'Seleccionar todos los visibles',
      onChange: (e) => {
        if (e.target.checked) for (const l of items) selected.add(l.id);
        else                  for (const l of items) selected.delete(l.id);
        redraw();
      },
    });
    const allShownSelected = items.length > 0 && items.every((l) => selected.has(l.id));
    if (allShownSelected) headerCb.checked = true;

    const COLSPAN = 17;
    const tbody = el('tbody', {});
    for (const l of items) {
      const isSel = selected.has(l.id);
      const rowCb = el('input', {
        type: 'checkbox', class: 'h-4 w-4 accent-navy', checked: isSel,
        onChange: (e) => {
          if (e.target.checked) selected.add(l.id); else selected.delete(l.id);
          redraw();
        },
      });
      const dwCls = (l.days_in_warehouse == null) ? 'text-ink-300'
        : l.days_in_warehouse > 20 ? 'text-crit font-bold'
        : l.days_in_warehouse > 10 ? 'text-warn font-semibold'
        : 'text-ink-700';
      const purchasesHere = l.purchases || [];
      const hasCommitments = l.enriched_assignments.length > 0 || purchasesHere.length > 0;
      const assignBtn = el('button', {
        type: 'button',
        class: 'ctrm-btn ctrm-btn-soft ctrm-btn-xs mt-1',
        title: 'Asignar a compra o pedido',
        onClick: (e) => { e.stopPropagation(); openAssignModal(l); },
      }, ['+ Asignar']);
      const orderList = el('div', { class: 'flex flex-col gap-0.5' }, [
        ...(hasCommitments ? [] : [el('span', { class: 'text-ink-300 italic', text: '— sin asignaciones' })]),
        // Pedidos FV
        ...l.enriched_assignments.map((a) =>
          el('div', { class: 'text-[11px] font-mono' }, [
            el('span', { class: 'text-navy font-semibold', text: a.order_code || '?' }),
            a.client_name ? el('span', { class: 'text-ink-500', text: ` · ${a.client_name}` }) : null,
            el('span', { class: 'text-ink-300', text: ` · ${fmtKg(a.kg_green_allocated)}` }),
          ])),
        // Compras directas
        ...purchasesHere.map((p) =>
          el('div', { class: 'text-[11px] font-mono flex items-center gap-1' }, [
            el('span', { class: 'ctrm-pill text-[8px]', style: 'background:#e8efe3;color:#2e4a2e;', text: 'COMPRA' }),
            el('span', { class: 'text-ink-700', text: p.client_name }),
            el('span', { class: 'text-ink-300', text: `· ${fmtKg(p.kg_green_allocated)}` }),
            el('button', {
              type: 'button', class: 'text-crit text-[11px] leading-none',
              title: 'Quitar compra',
              onClick: async (e) => {
                e.stopPropagation();
                try { await api.lotPurchaseDelete({ purchase_id: p.id }); navigate('/finca/punto-final'); }
                catch (err) { toast(err.message, 'error'); }
              },
            }, ['×']),
          ])),
        assignBtn,
      ]);
      const regionTxt = l._regions.length > 0 ? l._regions.join(', ') : '—';
      const partials = (l.partials || []).filter((p) => !p.rejected_at);
      const hasPartials = partials.length > 0;
      const isExp = expanded.has(l.id);

      const expandBtn = hasPartials
        ? el('button', {
            type: 'button',
            class: 'ctrm-btn ctrm-btn-ghost ctrm-btn-xs',
            title: isExp ? 'Ocultar parciales' : 'Ver parciales',
            onClick: (e) => {
              e.stopPropagation();
              if (isExp) expanded.delete(l.id); else expanded.add(l.id);
              redraw();
            },
          }, [`${isExp ? '▾' : '▸'} ${partials.length}`])
        : el('span', { class: 'text-ink-300 text-[10px]', text: '—' });

      tbody.append(el('tr', { class: isSel ? 'bg-cream' : 'hover:bg-cream' }, [
        cellNode('Sel', '', rowCb),
        cellNode('Bache', 'font-mono text-navy font-semibold', el('div', {}, [
          el('span', {
            class: 'cursor-pointer hover:underline',
            title: 'Ver historial del lote',
            onClick: () => navigate(`/finca/bache?id=${l.id}`),
          }, [
            l.is_blend ? el('span', { class: 'ctrm-pill text-[9px] mr-1', style: 'background:#e8efe3;color:#2e4a2e;', text: 'MEZCLA' }) : null,
            document.createTextNode(l.is_blend ? (l.blend_code || l.bache_code || l.lot_code) : (l.bache_code || l.lot_code)),
          ]),
          l.is_blend && (l.blend_components || []).length > 0
            ? el('div', { class: 'text-[10px] text-ink-500 font-mono mt-0.5',
                title: (l.blend_components || []).map((c) =>
                  `${c.bache_code || c.blend_code || c.lot_code}: ${fmtKg(c.kg_dried_used)} kg`).join(' · '),
                text: '← ' + (l.blend_components || [])
                  .map((c) => c.bache_code || c.blend_code || c.lot_code)
                  .join(' + '),
              })
            : null,
          l.is_blend
            ? el('button', {
                type: 'button',
                class: 'text-[10px] text-crit hover:underline mt-1',
                title: 'Eliminar esta mezcla y liberar los kg de los baches padre',
                onClick: async (e) => {
                  e.stopPropagation();
                  const ok = await confirmModal(
                    `¿Eliminar la mezcla ${l.blend_code || l.bache_code}? Los kg seco de los baches padre quedarán disponibles de nuevo.`,
                    { title: 'Eliminar mezcla', confirmText: 'Eliminar', danger: true },
                  );
                  if (!ok) return;
                  try {
                    await api.lotBlendDelete({ blend_lot_id: l.id });
                    toast('Mezcla eliminada', 'success');
                    navigate('/finca/punto-final');
                  } catch (err) { toast(err.message, 'error'); }
                },
              }, ['× Eliminar mezcla'])
            : null,
        ])),
        cellTxt('Referencia', '', l.reference_name || '—'),
        cellTxt('Proceso', 'text-[11px]', l.process_type),
        cellTxt('Variedades', 'text-[11px]', l._variety_names.length > 0 ? l._variety_names.join(', ') : '—'),
        cellNode('kg seco', 'text-right font-mono',
          l.kg_dried_output == null ? document.createTextNode('—')
          : el('div', {}, [
              el('div', { class: 'font-semibold text-navy', text: fmtKg(l.kg_dried_output) }),
              l.kg_dried_used_in_blends > 0
                ? el('div', { class: 'text-[9px] text-ok',
                    text: `${fmtKg(l.kg_dried_used_in_blends)} en mezcla` })
                : null,
            ])),
        cellTxt('kg verde', 'text-right font-mono', fmtKg(l.kg_verde)),
        cellTxt('Asignado v.', 'text-right font-mono text-ink-700',
          (l.kg_green_assigned || 0) > 0 ? fmtKg(l.kg_green_assigned) : '—'),
        cellTxt('Disponible v.',
          `text-right font-mono font-semibold ${(l.kg_green_available || 0) > 0.01 ? 'text-ok' : 'text-ink-300'}`,
          fmtKg(l.kg_green_available || 0)),
        cellTxt('Conversión', 'text-right font-mono', l.conversion_factor != null ? `${l.conversion_factor}×` : '—'),
        cellTxt('Humedad', 'text-right font-mono', l.final_humidity != null ? `${l.final_humidity}%` : '—'),
        cellNode('Parciales', 'text-center', expandBtn),
        cellTxt('Días bodega', `text-right font-mono ${dwCls}`, l.days_in_warehouse == null ? '—' : `${l.days_in_warehouse}d`),
        cellTxt('Días proceso', 'text-right font-mono', l.days_since_start == null ? '—' : `${l.days_since_start}d`),
        cellTxt('Listo desde', 'font-mono text-[11px]', l.ready_date ? fmtDate(l.ready_date) : '—'),
        cellNode('Pedido / Cliente', '', orderList),
        cellTxt('Región', 'text-[11px]', regionTxt),
      ]));

      if (hasPartials && isExp) {
        tbody.append(el('tr', { class: 'bg-cream' }, [
          el('td', { colspan: String(COLSPAN), class: 'p-3' }, [partialsBreakdown(partials)]),
        ]));
      }
    }

    // Totales sobre el set ya filtrado (items, no paged) para que el
    // operador vea la suma de lo que está mirando ahora.
    const sumSeco  = items.reduce((s, l) => s + Number(l.kg_dried_output || 0), 0);
    const sumVerde = items.reduce((s, l) => s + Number(l.kg_verde || 0), 0);
    const sumAssigned = items.reduce((s, l) => s + Number(l.kg_green_assigned || 0), 0);
    const sumAvail    = items.reduce((s, l) => s + Number(l.kg_green_available || 0), 0);
    // Conversión promedio ponderada por kg seco (sólo lotes con valor).
    let convAvg = null;
    let cwNum = 0, cwDen = 0;
    for (const l of items) {
      const c = Number(l.conversion_factor || 0);
      const w = Number(l.kg_dried_output || 0);
      if (c > 0 && w > 0) { cwNum += c * w; cwDen += w; }
    }
    if (cwDen > 0) convAvg = Math.round((cwNum / cwDen) * 10000) / 10000;

    const tfoot = items.length > 0
      ? el('tfoot', {}, [el('tr', { class: 'border-t-2 border-ink-300 bg-cream' }, [
          el('td', { class: 'w-8' }, []),
          el('td', { class: 'font-display text-[11px] uppercase tracking-eyebrow text-ink-700', text: `Total · ${items.length}` }),
          el('td', {}, []), el('td', {}, []), el('td', {}, []),
          el('td', { class: 'text-right font-mono font-semibold text-navy', text: fmtKg(sumSeco) }),
          el('td', { class: 'text-right font-mono font-semibold text-navy', text: fmtKg(sumVerde) }),
          el('td', { class: 'text-right font-mono text-ink-700', text: fmtKg(sumAssigned) }),
          el('td', { class: 'text-right font-mono font-semibold text-ok', text: fmtKg(sumAvail) }),
          el('td', { class: 'text-right font-mono text-ink-700', text: convAvg != null ? `${convAvg}× prom.` : '—' }),
          el('td', {}, []), el('td', {}, []), el('td', {}, []), el('td', {}, []), el('td', {}, []), el('td', {}, []), el('td', {}, []),
        ])])
      : null;

    const table = el('table', { class: `w-full text-[12px]${mobileTableMode ? '' : ' responsive-stack'}` }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { class: 'w-8' }, [headerCb]),
        sortHeader('Bache',         'bache'),
        sortHeader('Referencia',    'reference'),
        sortHeader('Proceso',       'process'),
        sortHeader('Variedades',    'varieties'),
        sortHeader('kg seco',       'kg_seco',     'text-right'),
        sortHeader('kg verde',      'kg_verde',    'text-right'),
        sortHeader('Asignado v.',   'asignado',    'text-right'),
        sortHeader('Disponible v.', 'disponible',  'text-right'),
        sortHeader('Conversión',    'conversion',  'text-right'),
        sortHeader('Humedad',       'humedad',     'text-right'),
        sortHeader('Parciales',     'parciales',   'text-center'),
        sortHeader('Días bodega',   'days_in_warehouse', 'text-right'),
        sortHeader('Días proceso',  'days_proceso','text-right'),
        sortHeader('Listo desde',   'ready_date'),
        sortHeader('Pedido / Cliente', 'asignaciones'),
        sortHeader('Región',        'region'),
      ])]),
      tbody,
      tfoot,
    ]);
    wrap.append(table);
    return wrap;
  }

  function partialsBreakdown(partials) {
    const sumDried = partials.reduce((s, p) => s + Number(p.kg_dried || 0), 0);
    const sumGreen = partials.reduce((s, p) => s + Number(p.kg_green_yield || 0), 0);
    let avgFactor = null;
    if (sumDried > 0) {
      const weighted = partials.reduce((s, p) => s + Number(p.factor_rendimiento || 0) * Number(p.kg_dried || 0), 0);
      avgFactor = Math.round((weighted / sumDried) * 100) / 100;
    }
    return el('div', { class: 'space-y-2' }, [
      el('div', { class: 'flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-500' }, [
        el('span', { class: 'eyebrow text-[10px]', text: `Parciales (${partials.length})` }),
        el('span', { class: 'font-mono text-ink-700' }, [`Total seco `, el('strong', { text: fmtKg(sumDried) })]),
        el('span', { class: 'font-mono text-ink-700' }, [`Total verde `, el('strong', { text: fmtKg(sumGreen) })]),
        avgFactor != null ? el('span', { class: 'font-mono text-ink-700' }, [`Factor prom. `, el('strong', { text: String(avgFactor) })]) : null,
      ]),
      el('div', { class: 'overflow-x-auto bg-white rounded-md border border-sand' }, [
        el('table', { class: 'w-full text-[11px]' }, [
          el('thead', {}, [el('tr', { class: 'text-ink-300 uppercase tracking-loose' }, [
            el('th', { class: 'text-left px-2 py-1' }, ['Parcial']),
            el('th', { class: 'text-right px-2 py-1' }, ['kg seco']),
            el('th', { class: 'text-right px-2 py-1' }, ['Factor']),
            el('th', { class: 'text-right px-2 py-1' }, ['kg verde']),
            el('th', { class: 'text-left px-2 py-1' }, ['Despachado en']),
          ])]),
          el('tbody', {}, partials.map((p) => el('tr', { class: 'border-t border-sand' }, [
            el('td', { class: 'px-2 py-1 font-mono font-semibold', text: `Parcial ${p.parcial_letter}` }),
            el('td', { class: 'px-2 py-1 text-right font-mono', text: fmtKg(p.kg_dried) }),
            el('td', { class: 'px-2 py-1 text-right font-mono', text: String(p.factor_rendimiento) }),
            el('td', { class: 'px-2 py-1 text-right font-mono font-bold', text: fmtKg(p.kg_green_yield) }),
            el('td', { class: 'px-2 py-1 text-ink-500', text: p.shipment_code ? `${p.shipment_code}` : '—' }),
          ]))),
        ]),
      ]),
    ]);
  }

  // ── Modal: asignar a compra (directa) o a pedido FV existente ──
  async function openAssignModal(lot) {
    const available = Number(lot.kg_green_available || 0);
    const ACTIVE = new Set(['Accepted', 'PartiallyAccepted', 'InProduction', 'Completed']);
    const compatibleOrders = allOrders.filter((o) =>
      ACTIVE.has(o.status) &&
      o.process_type === lot.process_type &&
      (!lot.reference_id || o.reference_id === lot.reference_id));

    const out = await openModal(({ close }) => {
      let mode = 'directa'; // 'directa' | 'pedido'

      // Compra directa
      const clientInput = el('input', { type: 'text', class: 'ctrm-input w-full', placeholder: 'Nombre del cliente' });
      const notesInput  = el('input', { type: 'text', class: 'ctrm-input w-full', placeholder: 'Notas (opcional)' });

      // Pedido existente
      const orderSelect = el('select', { class: 'ctrm-input w-full' }, [
        el('option', { value: '' }, ['— Selecciona un pedido —']),
        ...compatibleOrders.map((o) => el('option', { value: o.id },
          [`${o.order_code || o.id.slice(0, 8)}${o.client_name ? ' · ' + o.client_name : ''} · acepta ${fmtKg(o.kg_green_accepted || o.kg_green_required || 0)}`])),
      ]);

      const kgInput = el('input', {
        type: 'number', step: '0.01', min: '0.01', max: String(available),
        value: available > 0 ? String(available) : '',
        class: 'ctrm-input mono text-right w-full',
        placeholder: `Máx ${fmtKg(available)}`,
      });

      const directaBox = el('div', { class: 'space-y-2' }, [
        el('div', {}, [el('label', { class: 'ctrm-label', text: 'Cliente' }), clientInput]),
        el('div', {}, [el('label', { class: 'ctrm-label', text: 'Notas' }), notesInput]),
      ]);
      const pedidoBox = el('div', { class: 'space-y-2' }, [
        compatibleOrders.length === 0
          ? el('p', { class: 'text-[12px] text-warn', text: 'No hay pedidos compatibles (mismo proceso/referencia).' })
          : el('div', {}, [el('label', { class: 'ctrm-label', text: 'Pedido' }), orderSelect]),
      ]);
      pedidoBox.style.display = 'none';

      const tabBtn = (key, label) => el('button', {
        type: 'button',
        class: `ctrm-btn ctrm-btn-xs ${mode === key ? 'ctrm-btn-primary' : 'ctrm-btn-soft'}`,
        onClick: () => {
          mode = key;
          directaBox.style.display = key === 'directa' ? '' : 'none';
          pedidoBox.style.display  = key === 'pedido'  ? '' : 'none';
          tabs.replaceChildren(tabBtn('directa', 'Compra directa'), tabBtn('pedido', 'Pedido existente'));
        },
      }, [label]);
      const tabs = el('div', { class: 'flex gap-2' }, [tabBtn('directa', 'Compra directa'), tabBtn('pedido', 'Pedido existente')]);

      return el('div', { class: 'space-y-3' }, [
        el('div', { class: 'rounded-lg bg-cream border border-sand p-3 text-[12px]' }, [
          el('p', {}, [
            `Bache `, el('strong', { class: 'text-navy', text: lot.bache_code || lot.blend_code || lot.lot_code }),
            ` · disponible `, el('strong', { class: 'text-ok', text: `${fmtKg(available)} kg verde` }),
          ]),
        ]),
        tabs,
        directaBox,
        pedidoBox,
        el('div', {}, [el('label', { class: 'ctrm-label', text: 'kg verde a asignar' }), kgInput]),
        el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
          el('button', { type: 'button', class: 'ctrm-btn ctrm-btn-ghost', onClick: () => close(null) }, ['Cancelar']),
          el('button', { type: 'button', class: 'ctrm-btn ctrm-btn-primary', onClick: async () => {
            const kg = Number(kgInput.value);
            if (!Number.isFinite(kg) || kg <= 0) { toast('Indica kg verde > 0', 'warning'); return; }
            if (kg > available + 0.01) { toast(`Excede el disponible (${fmtKg(available)} kg verde)`, 'error'); return; }
            try {
              if (mode === 'directa') {
                const client = clientInput.value.trim();
                if (!client) { toast('Indica el nombre del cliente', 'warning'); return; }
                await api.lotPurchaseCreate({
                  production_lot_id: lot.id, client_name: client,
                  kg_green_allocated: kg, notes: notesInput.value || undefined,
                });
              } else {
                if (!orderSelect.value) { toast('Selecciona un pedido', 'warning'); return; }
                await api.assignmentsCreate({
                  production_lot_id: lot.id,
                  assignments: [{ demand_order_id: orderSelect.value, kg_green_allocated: kg }],
                });
              }
              close({ ok: true });
            } catch (e) { toast(e.message || 'Error al asignar', 'error'); }
          } }, ['Asignar']),
        ]),
      ]);
    }, { title: `Asignar ${lot.bache_code || lot.lot_code}` });

    if (out && out.ok) { toast('Asignación registrada', 'success'); navigate('/finca/punto-final'); }
  }

  redraw();
  return chrome(root);
}

// ─── helpers ────────────────────────────────────────────────────────
function kpiCard(label, value, hint, kind) {
  const valClass = kind ? `stat-val ${kind}` : 'stat-val';
  return el('div', { class: 'stat-card' }, [
    el('p', { class: 'stat-label', text: label }),
    el('p', { class: valClass, text: value }),
    el('p', { class: 'stat-sub', text: hint }),
  ]);
}

function cellTxt(label, classes, value) {
  const td = el('td', { class: classes });
  td.setAttribute('data-label', label);
  td.append(document.createTextNode(value == null ? '—' : String(value)));
  return td;
}
function cellNode(label, classes, node) {
  const td = el('td', { class: classes });
  td.setAttribute('data-label', label);
  if (node) td.append(node);
  return td;
}

// ── Modal de mezcla ────────────────────────────────────────────────
// Recibe los baches seleccionados, permite ajustar kg seco a aportar
// por cada uno y crea la mezcla. Reglas: Natural solo con Natural;
// Honey/Lavado entre sí. Las variedades del blend = unión.
async function openBlendModal(parents) {
  // Validar compatibilidad de procesos antes de abrir el modal.
  const processes = [...new Set(parents.map((p) => p.process_type))];
  const hasNatural = processes.includes('Natural');
  const hasHL = processes.includes('Honey') || processes.includes('Lavado');
  if (hasNatural && hasHL) {
    toast('Natural no se puede mezclar con Honey/Lavado', 'warning'); return null;
  }
  if (hasNatural && processes.length > 1) {
    toast('Solo se permite Natural con Natural', 'warning'); return null;
  }

  // Estado: kg a usar por cada padre (default = kg_dried_available).
  const components = parents.map((p) => ({
    source_lot_id: p.id,
    bache_code: p.bache_code || p.blend_code || p.lot_code,
    process_type: p.process_type,
    kg_available: Number(p.kg_dried_available != null
      ? p.kg_dried_available : (p.kg_dried_output || 0)),
    kg_dried_used: Number(p.kg_dried_available != null
      ? p.kg_dried_available : (p.kg_dried_output || 0)),
  }));

  const notesInput = el('input', { type: 'text', class: 'ctrm-input w-full',
    placeholder: 'Notas opcionales' });

  let total = components.reduce((s, c) => s + c.kg_dried_used, 0);
  const totalSpan = el('strong', { class: 'text-navy', text: fmtKg(total) });
  const updateTotal = () => {
    total = components.reduce((s, c) => s + Number(c.kg_dried_used || 0), 0);
    totalSpan.textContent = fmtKg(total);
  };

  return openModal((close) => {
    return el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-[12px] text-ink-700',
        text: 'Indica los kg de seco a aportar de cada bache. Default: todo el disponible.' }),

      el('div', { class: 'border border-sand rounded-md overflow-hidden' }, [
        el('table', { class: 'w-full text-[12px]' }, [
          el('thead', {}, [el('tr', { class: 'bg-cream text-ink-500' }, [
            el('th', { class: 'text-left px-3 py-1.5 font-display text-[10px] uppercase tracking-eyebrow', text: 'Bache' }),
            el('th', { class: 'text-left px-3 py-1.5 font-display text-[10px] uppercase tracking-eyebrow', text: 'Proceso' }),
            el('th', { class: 'text-right px-3 py-1.5 font-display text-[10px] uppercase tracking-eyebrow', text: 'Disponible' }),
            el('th', { class: 'text-right px-3 py-1.5 font-display text-[10px] uppercase tracking-eyebrow', text: 'A aportar (kg)' }),
          ])]),
          el('tbody', {}, components.map((c) => {
            const inp = el('input', {
              type: 'number', step: '0.01', min: '0', max: String(c.kg_available),
              value: String(c.kg_dried_used),
              class: 'ctrm-input text-right w-28 mono',
            });
            inp.addEventListener('input', () => {
              const v = Number(inp.value);
              c.kg_dried_used = isFinite(v) ? v : 0;
              updateTotal();
            });
            return el('tr', { class: 'border-t border-sand' }, [
              el('td', { class: 'px-3 py-1.5 font-mono text-navy', text: c.bache_code }),
              el('td', { class: 'px-3 py-1.5', text: c.process_type }),
              el('td', { class: 'px-3 py-1.5 text-right font-mono text-ink-700', text: `${fmtKg(c.kg_available)} kg` }),
              el('td', { class: 'px-3 py-1.5 text-right' }, [inp]),
            ]);
          })),
        ]),
      ]),

      el('div', { class: 'flex items-baseline justify-between text-[12px] font-mono pt-2' }, [
        el('span', { class: 'text-ink-500', text: 'Total kg seco de la mezcla:' }),
        totalSpan,
      ]),

      el('div', {}, [
        el('label', { class: 'block text-[11px] text-ink-500 mb-1', text: 'Notas' }),
        notesInput,
      ]),

      el('div', { class: 'flex justify-end gap-2 pt-3 border-t border-sand' }, [
        el('button', { type: 'button', class: 'ctrm-btn ctrm-btn-ghost',
          onClick: () => close(null) }, ['Cancelar']),
        (() => {
          const submitBtn = el('button', { type: 'button', class: 'ctrm-btn ctrm-btn-primary' }, ['Crear mezcla']);
          submitBtn.addEventListener('click', async () => {
            if (submitBtn.disabled) return;
            // Filtrar componentes con kg > 0
            const items = components
              .filter((c) => c.kg_dried_used > 0)
              .map((c) => ({ source_lot_id: c.source_lot_id, kg_dried_used: c.kg_dried_used }));
            if (items.length < 2) { toast('Necesitas al menos 2 componentes con kg > 0', 'warning'); return; }
            for (const c of components) {
              if (c.kg_dried_used > c.kg_available + 0.01) {
                toast(`${c.bache_code}: excede el disponible (${fmtKg(c.kg_available)} kg)`, 'error');
                return;
              }
            }
            submitBtn.disabled = true;
            submitBtn.textContent = 'Creando…';
            try {
              await api.lotBlendCreate({ components: items, notes: notesInput.value || null });
              close({ ok: true });
            } catch (e) {
              toast(e.message || 'Error al crear mezcla', 'error');
              submitBtn.disabled = false;
              submitBtn.textContent = 'Crear mezcla';
            }
          });
          return submitBtn;
        })(),
      ]),
    ]);
  }, { title: `Mezclar ${parents.length} baches`, wide: true });
}

function daysBetween(fromYmd, toYmd) {
  if (!fromYmd || !toYmd) return null;
  const a = new Date(fromYmd + 'T00:00:00Z');
  const b = new Date(toYmd   + 'T00:00:00Z');
  return Math.max(0, Math.floor((b - a) / 86400000));
}
