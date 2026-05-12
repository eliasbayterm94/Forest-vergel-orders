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

export async function fincaPuntoFinalView() {
  const [lotsRes, ordersRes] = await Promise.all([
    api.lotsList({ status: 'Ready' }),
    api.ordersList({}),
  ]);
  const lots = lotsRes.lots || [];
  const ordersById = new Map((ordersRes.orders || []).map((o) => [o.id, o]));
  const today = ordersRes.today || new Date().toISOString().slice(0, 10);

  // Enriquecer cada lote: kg verde efectivo, dias en bodega (ready_date)
  // y dias desde proceso (start_date). Tambien collectar pedidos
  // asignados con su cliente / region / contrato.
  const enriched = lots.map((l) => {
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
  }).sort((a, b) => (b.days_in_warehouse || 0) - (a.days_in_warehouse || 0));

  // ── Filtros ──
  let sheetValues = {};
  let dateFromValue = '';
  let dateToValue = '';
  const selected = new Set();

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
    const shown = enriched.filter(passes);
    const totalKg = shown.reduce((s, l) => s + Number(l.kg_verde || 0), 0);
    const uniqueOrders = new Set();
    for (const l of shown) for (const a of l.enriched_assignments) if (a.order_id) uniqueOrders.add(a.order_id);

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

    const cta = el('button', {
      class: 'ctrm-btn ctrm-btn-yellow uppercase tracking-eyebrow text-[11px]',
      type: 'button',
      onClick: () => {
        if (selected.size === 0) { toast('Selecciona al menos un lote', 'warning'); return; }
        try {
          sessionStorage.setItem('punto-final-preselect', JSON.stringify([...selected]));
        } catch { /* fallback: nada */ }
        navigate('/finca/despachos');
      },
    }, [selected.size > 0 ? `Generar despacho (${selected.size})` : 'Generar despacho']);

    root.append(
      pageTitle('Punto Final', `Lotes en bodega · ${shown.length} de ${enriched.length}`, cta),

      // KPI cards
      el('div', { class: 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-4' }, [
        kpiCard('Lotes',   String(shown.length),   'En bodega'),
        kpiCard('Pedidos', String(uniqueOrders.size), 'Únicos asignados'),
        kpiCard('Verde',   fmtKg(totalKg),         'Total kg verde'),
        kpiCard('0–10 d',  String(b_0_10),  'Recientes', 'ok'),
        kpiCard('11–20 d', String(b_11_20), 'Atención',  b_11_20 > 0 ? 'warn' : null),
        kpiCard('>20 d',   String(b_21),    'Críticos',  b_21 > 0 ? 'crit' : null),
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
      ]),

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

    const table = el('table', { class: 'w-full text-[12px] responsive-stack' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { class: 'w-8' }, [headerCb]),
        el('th', {}, ['Bache']),
        el('th', {}, ['Referencia']),
        el('th', {}, ['Proceso']),
        el('th', {}, ['Variedades']),
        el('th', { class: 'text-right' }, ['kg verde']),
        el('th', { class: 'text-right' }, ['Días bodega']),
        el('th', { class: 'text-right' }, ['Días proceso']),
        el('th', {}, ['Listo desde']),
        el('th', {}, ['Pedido / Cliente']),
        el('th', {}, ['Región']),
      ])]),
      el('tbody', {}, items.map((l) => {
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
        const orderList = l.enriched_assignments.length === 0
          ? el('span', { class: 'text-ink-300 italic', text: '— sin asignaciones' })
          : el('div', { class: 'flex flex-col gap-0.5' },
              l.enriched_assignments.map((a) =>
                el('div', { class: 'text-[11px] font-mono' }, [
                  el('span', { class: 'text-navy font-semibold', text: a.order_code || '?' }),
                  a.client_name ? el('span', { class: 'text-ink-500', text: ` · ${a.client_name}` }) : null,
                  el('span', { class: 'text-ink-300', text: ` · ${fmtKg(a.kg_green_allocated)}` }),
                ])));
        const regionTxt = l._regions.length > 0 ? l._regions.join(', ') : '—';
        return el('tr', { class: isSel ? 'bg-cream' : 'hover:bg-cream' }, [
          cellNode('Sel', '', rowCb),
          cellTxt('Bache', 'font-mono text-navy font-semibold', l.bache_code || l.lot_code),
          cellTxt('Referencia', '', l.reference_name || '—'),
          cellTxt('Proceso', 'text-[11px]', l.process_type),
          cellTxt('Variedades', 'text-[11px]', l._variety_names.length > 0 ? l._variety_names.join(', ') : '—'),
          cellTxt('kg verde', 'text-right font-mono', fmtKg(l.kg_verde)),
          cellTxt('Días bodega', `text-right font-mono ${dwCls}`, l.days_in_warehouse == null ? '—' : `${l.days_in_warehouse}d`),
          cellTxt('Días proceso', 'text-right font-mono', l.days_since_start == null ? '—' : `${l.days_since_start}d`),
          cellTxt('Listo desde', 'font-mono text-[11px]', l.ready_date ? fmtDate(l.ready_date) : '—'),
          cellNode('Pedido / Cliente', '', orderList),
          cellTxt('Región', 'text-[11px]', regionTxt),
        ]);
      })),
    ]);
    wrap.append(table);
    return wrap;
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

function daysBetween(fromYmd, toYmd) {
  if (!fromYmd || !toYmd) return null;
  const a = new Date(fromYmd + 'T00:00:00Z');
  const b = new Date(toYmd   + 'T00:00:00Z');
  return Math.max(0, Math.floor((b - a) / 86400000));
}
