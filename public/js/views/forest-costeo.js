// Costeo de lotes — la pantalla de Forest/admin.
//
// Tres preguntas, en este orden:
//   1. ¿Cuánto me costó cada kg de café seco?
//   2. ¿Cómo cerró el mes contra el mandato?
//   3. ¿El factor real se parece al que esperaba?
//
// La finca no entra acá: ella registra kg, no plata.

import { el, clear } from '../ui/el.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { toast } from '../ui/toast.js';
import { withBusy } from '../ui/busy.js';
import { sortableTable } from '../ui/sortable-table.js';
import { fmtKg, fmtDate } from '../ui/format.js';

const NF = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
const cop = (n) => (n == null ? '—' : `$ ${NF.format(Math.round(Number(n)))}`);
const pctOf = (n) => (n == null ? '—' : `${(Number(n) * 100).toFixed(1)}%`);

const ORIGIN_LABEL = {
  propio: 'Propio', comprado: 'Comprado', mixto: 'Mixto',
  mezcla: 'Mezcla', subproducto: 'Subproducto',
};

export async function forestCosteoView() {
  const now = new Date(Date.now() - 5 * 3600 * 1000);
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1;

  const [reportRes, closuresRes] = await Promise.all([
    api.lotCostsReport({}).catch(() => ({ lots: [] })),
    api.monthlyClosuresList({}).catch(() => ({ closures: [], ytd: null })),
  ]);

  let lots = (reportRes && reportRes.lots) || [];
  let closures = (closuresRes && closuresRes.closures) || [];
  let ytd = (closuresRes && closuresRes.ytd) || null;
  let monthData = null;

  const root = el('div', {});

  async function loadMonth() {
    try {
      const r = await api.monthlyClosureCompute({ year, month });
      monthData = r;
    } catch (e) {
      monthData = null;
      toast(e.message || 'No se pudo calcular el mes', 'error');
    }
    redraw();
  }

  async function reloadAll() {
    const [rep, cl] = await Promise.all([
      api.lotCostsReport({}).catch(() => ({ lots: [] })),
      api.monthlyClosuresList({}).catch(() => ({ closures: [], ytd: null })),
    ]);
    lots = (rep && rep.lots) || [];
    closures = (cl && cl.closures) || [];
    ytd = (cl && cl.ytd) || null;
    await loadMonth();
  }

  function redraw() {
    clear(root);
    root.append(
      monthSection(),
      ytdSection(ytd, closures),
      lotsSection(lots),
    );
  }

  // ── Cierre del mes ───────────────────────────────────────────
  function monthSection() {
    const yearInput = el('input', { type: 'number', min: '2020', max: '2100', step: '1',
      value: String(year), class: 'ctrm-input mono w-24' });
    const monthInput = el('input', { type: 'number', min: '1', max: '12', step: '1',
      value: String(month), class: 'ctrm-input mono w-20' });
    const loadBtn = el('button', { class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm', type: 'button' }, ['Ver mes']);
    loadBtn.addEventListener('click', () => {
      const y = Number(yearInput.value), m = Number(monthInput.value);
      if (!(y >= 2020 && y <= 2100) || !(m >= 1 && m <= 12)) {
        toast('Año o mes inválido', 'warning'); return;
      }
      year = y; month = m; loadMonth();
    });

    const body = el('div', { class: 'space-y-3' });

    if (!monthData) {
      body.append(el('p', { class: 'text-[12px] text-ink-300 italic',
        text: 'Elige un mes y presiona Ver mes.' }));
    } else if (monthData.table_missing) {
      body.append(el('p', { class: 'text-[12px] text-warn',
        text: 'Las migraciones de costeo (0051/0052) no están aplicadas todavía.' }));
    } else {
      const c = monthData.computed;
      const existing = monthData.existing;

      const mandateInput = el('input', {
        type: 'number', min: '0', step: '1', class: 'ctrm-input mono',
        placeholder: 'COP del mes',
        value: existing && existing.actual_mandate_cop != null ? String(existing.actual_mandate_cop) : '',
      });
      const bpInput = el('input', {
        type: 'number', min: '0', step: '1', class: 'ctrm-input mono',
        placeholder: 'Opcional',
        value: existing && existing.byproduct_revenue_cop != null ? String(existing.byproduct_revenue_cop) : '',
      });

      const diffLine = el('p', { class: 'text-[12px] font-mono' });
      function recalcDiff() {
        const m = mandateInput.value === '' ? null : Number(mandateInput.value);
        if (m == null) {
          diffLine.textContent = 'Escribe el mandato real del mes para ver la diferencia.';
          diffLine.className = 'text-[12px] text-ink-300 italic';
          return;
        }
        const d = m - c.absorbed_total_cop;
        diffLine.textContent = `Diferencia de mandato: ${cop(d)}`
          + (m > 0 ? ` (${((d / m) * 100).toFixed(1)}% del mandato)` : '');
        diffLine.className = `text-[12px] font-mono font-semibold ${d > 0 ? 'text-crit' : 'text-ok'}`;
      }
      mandateInput.addEventListener('input', recalcDiff);
      recalcDiff();

      const saveBtn = el('button', { class: 'ctrm-btn ctrm-btn-primary', type: 'button' },
        [existing ? 'Actualizar cierre' : 'Guardar cierre']);
      saveBtn.addEventListener('click', async () => {
        try {
          await withBusy(saveBtn, 'Guardando…', () => api.monthlyClosureSave({
            year, month,
            actual_mandate_cop: mandateInput.value === '' ? null : Number(mandateInput.value),
            byproduct_revenue_cop: bpInput.value === '' ? null : Number(bpInput.value),
          }));
          toast(`Cierre de ${month}/${year} guardado`, 'success');
          await reloadAll();
        } catch (e) { toast(e.message || 'No se pudo guardar', 'error', 6000); }
      });

      body.append(
        el('div', { class: 'grid grid-cols-2 sm:grid-cols-4 gap-3' }, [
          metric('Absorbido T1', cop(c.absorbed_t1_cop)),
          metric('Absorbido T2', cop(c.absorbed_t2_cop)),
          metric('Absorbido total', cop(c.absorbed_total_cop), 'text-navy'),
          metric('Salidas en seco', String(c.snapshot_count)),
        ]),
        el('div', { class: 'grid grid-cols-2 sm:grid-cols-4 gap-3' }, [
          metric('kg netos procesados', fmtKg(c.kg_net_processed)),
          metric('kg seco producidos', fmtKg(c.kg_dried_produced)),
          metric('Factor real', c.real_factor == null ? '—' : c.real_factor.toFixed(4)),
          metric('Costo medio /kg seco', cop(c.avg_cost_per_kg_dried)),
        ]),
        el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-sand' }, [
          el('div', {}, [el('label', { class: 'ctrm-label', text: 'Mandato real del mes (COP)' }), mandateInput]),
          el('div', {}, [el('label', { class: 'ctrm-label', text: 'Venta de subproducto (COP)' }), bpInput]),
        ]),
        diffLine,
        // El subproducto no tiene costo (su procesamiento ya está en T1),
        // así que su venta es margen directo.
        el('p', { class: 'text-[11px] text-ink-500',
          text: 'La venta de subproducto es margen directo: su costo es cero porque su procesamiento ya está dentro de T1.' }),
        c.inherited_blend_count > 0
          ? el('p', { class: 'text-[11px] text-ink-500',
              text: `${c.inherited_blend_count} mezcla(s) del mes heredan costo y no aportan T1 — su cereza ya lo pagó.` })
          : null,
        saveBtn,
      );
    }

    return el('section', { class: 'ctrm-card ctrm-card-pad space-y-3' }, [
      el('div', { class: 'flex items-end justify-between gap-2 flex-wrap' }, [
        el('p', { class: 'eyebrow text-[10px]', text: 'Cierre mensual' }),
        el('div', { class: 'flex items-end gap-2' }, [
          el('div', {}, [el('label', { class: 'ctrm-label', text: 'Año' }), yearInput]),
          el('div', {}, [el('label', { class: 'ctrm-label', text: 'Mes' }), monthInput]),
          loadBtn,
        ]),
      ]),
      body,
    ]);
  }

  loadMonth();

  return chrome(el('div', {}, [
    pageTitle('Costeo de lotes', 'Costo por kg seco, cierre mensual y factor real'),
    root,
  ]));
}

// ── Acumulado del año ──────────────────────────────────────────
function ytdSection(ytd, closures) {
  if (!ytd) {
    return el('section', { class: 'ctrm-card ctrm-card-pad mt-4' }, [
      el('p', { class: 'eyebrow text-[10px] mb-1', text: 'Acumulado del año' }),
      el('p', { class: 'text-[12px] text-ink-300 italic',
        text: 'Sin meses cerrados con mandato real todavía.' }),
    ]);
  }
  return el('section', { class: 'ctrm-card ctrm-card-pad mt-4 space-y-3' }, [
    el('p', { class: 'eyebrow text-[10px]', text: `Acumulado del año · ${ytd.months} mes(es)` }),
    el('div', { class: 'grid grid-cols-2 sm:grid-cols-4 gap-3' }, [
      metric('Absorbido', cop(ytd.absorbed_total_cop)),
      metric('Mandato real', cop(ytd.actual_mandate_cop)),
      metric('Diferencia', cop(ytd.mandate_difference_cop),
        Number(ytd.mandate_difference_cop) > 0 ? 'text-crit' : 'text-ok'),
      metric('% del mandato', pctOf(ytd.difference_pct_of_mandate)),
    ]),
    closures.length > 0 ? closuresTable(closures) : null,
  ]);
}

function closuresTable(closures) {
  const cell = (label, classes, content) => {
    const td = el('td', { class: classes });
    td.setAttribute('data-label', label);
    td.append(document.createTextNode(String(content == null ? '—' : content)));
    return td;
  };
  const t = sortableTable({
    headers: [
      { label: 'Periodo', sortGetter: (c) => `${c.year}-${String(c.month).padStart(2, '0')}` },
      { label: 'Absorbido', sortGetter: (c) => Number(c.absorbed_total_cop || 0), cls: 'text-right' },
      { label: 'Mandato', sortGetter: (c) => Number(c.actual_mandate_cop || 0), cls: 'text-right' },
      { label: 'Diferencia', sortGetter: (c) => Number(c.mandate_difference_cop || 0), cls: 'text-right' },
      { label: 'kg netos', sortGetter: (c) => Number(c.kg_net_processed || 0), cls: 'text-right' },
      { label: 'kg seco', sortGetter: (c) => Number(c.kg_dried_produced || 0), cls: 'text-right' },
    ],
    items: closures,
    defaultSort: { index: 0, dir: 'desc' },
    renderRow: (c) => el('tr', { class: 'border-t border-sand' }, [
      cell('Periodo', 'px-2 py-2 font-mono text-[12px]', `${String(c.month).padStart(2, '0')}/${c.year}`),
      cell('Absorbido', 'px-2 py-2 text-right font-mono', cop(c.absorbed_total_cop)),
      cell('Mandato', 'px-2 py-2 text-right font-mono', c.actual_mandate_cop == null ? 'sin digitar' : cop(c.actual_mandate_cop)),
      cell('Diferencia', `px-2 py-2 text-right font-mono ${Number(c.mandate_difference_cop) > 0 ? 'text-crit' : 'text-ok'}`,
        c.mandate_difference_cop == null ? '—' : cop(c.mandate_difference_cop)),
      cell('kg netos', 'px-2 py-2 text-right font-mono', fmtKg(c.kg_net_processed)),
      cell('kg seco', 'px-2 py-2 text-right font-mono', fmtKg(c.kg_dried_produced)),
    ]),
  });
  return el('div', { class: 'mt-2' }, [t.el]);
}

// ── Costo por lote ─────────────────────────────────────────────
function lotsSection(lots) {
  if (!lots || lots.length === 0) {
    return el('section', { class: 'ctrm-card ctrm-card-pad mt-4 text-center' }, [
      el('p', { class: 'eyebrow text-[10px] mb-1', text: 'Costo por lote' }),
      el('p', { class: 'text-[12px] text-ink-300 italic',
        text: 'Ningún lote costeado todavía. Se costean solos al salir en seco.' }),
    ]);
  }

  const cell = (label, classes, content) => {
    const td = el('td', { class: classes });
    td.setAttribute('data-label', label);
    if (content instanceof Node) td.append(content);
    else td.append(document.createTextNode(String(content == null ? '—' : content)));
    return td;
  };

  const t = sortableTable({
    headers: [
      { label: 'Bache', sortGetter: (l) => l.code || '' },
      { label: 'Salió', sortGetter: (l) => l.snapshot_date || '' },
      { label: 'Proceso', sortGetter: (l) => l.process_type || '' },
      { label: 'Origen', sortGetter: (l) => l.origin },
      { label: 'kg netos', sortGetter: (l) => l.kg_input_net_total, cls: 'text-right' },
      { label: 'kg seco', sortGetter: (l) => l.kg_dried_output, cls: 'text-right' },
      { label: 'Factor real', sortGetter: (l) => l.real_factor ?? -1, cls: 'text-right' },
      { label: 'Costo total', sortGetter: (l) => l.total_cost_cop, cls: 'text-right' },
      { label: '$/kg seco', sortGetter: (l) => l.cost_per_kg_dried ?? -1, cls: 'text-right' },
    ],
    items: lots,
    defaultSort: { index: 1, dir: 'desc' },
    totals: [
      { label: 'Total', value: () => 'Total', cls: 'font-semibold text-ink-700' },
      null, null, null,
      { value: (a) => fmtKg(a.reduce((s, l) => s + l.kg_input_net_total, 0)), cls: 'text-right font-mono' },
      { value: (a) => fmtKg(a.reduce((s, l) => s + l.kg_dried_output, 0)), cls: 'text-right font-mono' },
      null,
      { value: (a) => cop(a.reduce((s, l) => s + l.total_cost_cop, 0)), cls: 'text-right font-mono font-semibold' },
      { value: (a) => {
          const kg = a.reduce((s, l) => s + l.kg_dried_output, 0);
          const c = a.reduce((s, l) => s + l.total_cost_cop, 0);
          return kg > 0 ? cop(c / kg) : '—';
        }, cls: 'text-right font-mono font-semibold text-navy' },
    ],
    renderRow: (l) => el('tr', { class: `border-t border-sand ${l.voided_at ? 'opacity-50' : ''}` }, [
      cell('Bache', 'px-2 py-2 font-mono text-[12px] text-navy', l.code || '—'),
      cell('Salió', 'px-2 py-2 font-mono text-[12px]', l.snapshot_date ? fmtDate(l.snapshot_date) : '—'),
      cell('Proceso', 'px-2 py-2 text-[12px]', l.process_type || '—'),
      cell('Origen', 'px-2 py-2', el('span', {
        class: `ctrm-pill text-[10px] ${l.origin === 'propio' ? 'ok' : l.origin === 'subproducto' ? 'muted' : ''}`,
        text: ORIGIN_LABEL[l.origin] || l.origin,
      })),
      cell('kg netos', 'px-2 py-2 text-right font-mono', fmtKg(l.kg_input_net_total)),
      cell('kg seco', 'px-2 py-2 text-right font-mono', fmtKg(l.kg_dried_output)),
      cell('Factor real', 'px-2 py-2 text-right font-mono',
        l.real_factor == null ? '—' : l.real_factor.toFixed(4)),
      cell('Costo total', 'px-2 py-2 text-right font-mono', cop(l.total_cost_cop)),
      cell('$/kg seco', 'px-2 py-2 text-right font-mono font-semibold', cop(l.cost_per_kg_dried)),
    ]),
  });

  return el('div', { class: 'mt-4' }, [
    el('p', { class: 'eyebrow text-[10px] mb-2', text: 'Costo por lote · congelado al salir en seco' }),
    t.el,
  ]);
}

function metric(label, value, extraCls = '') {
  return el('div', { class: 'ctrm-card ctrm-card-pad' }, [
    el('p', { class: 'text-[10px] text-ink-500 uppercase tracking-eyebrow font-semibold', text: label }),
    el('p', { class: `font-display font-semibold text-[16px] leading-tight ${extraCls || 'text-ink-700'}`, text: value }),
  ]);
}
