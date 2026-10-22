// Recepciones de materia prima — la pantalla "llegó café".
//
// Una sola pantalla captura la entrega y los flotes que se le
// separaron, porque el kg NETO es lo que carga el costo y tenerlo bien
// desde el primer guardado evita un segundo paso que alguien olvide.
//
// La finca NO digita plata: escribe kg y el precio de la factura, y la
// pantalla le muestra lo que eso implica. Los reportes de costo viven
// en el perfil de Forest/admin, no acá.

import { el, clear } from '../ui/el.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { toast } from '../ui/toast.js';
import { withBusy } from '../ui/busy.js';
import { sortableTable } from '../ui/sortable-table.js';
import { openModal } from '../ui/modal.js';
import { getSession } from '../auth.js';
import { fmtKg, fmtDate } from '../ui/format.js';

const STAGES = [['cereza', 'Cereza'], ['despulpado', 'Despulpado'], ['seco', 'Seco']];

const NF_COP = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
const cop = (n) => (n == null ? '—' : `$ ${NF_COP.format(Math.round(Number(n)))}`);
const pct = (n) => (n == null ? '—' : `${(Number(n) * 100).toFixed(1)}%`);

export async function fincaRecepcionesView() {
  const [supRes, poolRes, recRes] = await Promise.all([
    api.suppliersList({}).catch(() => ({ suppliers: [] })),
    api.costPoolsList({}).catch(() => ({ pools: [] })),
    api.receptionsList({}).catch(() => ({ receptions: [] })),
  ]);

  const suppliers = (supRes && supRes.suppliers) || [];
  let pools = (poolRes && poolRes.pools) || [];
  let receptions = (recRes && recRes.receptions) || [];

  const root = el('div', {});

  const supSelect = el('select', { class: 'ctrm-select' }, []);
  function paintSuppliers(selectId) {
    clear(supSelect);
    supSelect.append(el('option', { value: '' }, ['Elige proveedor…']));
    for (const s of suppliers) {
      supSelect.append(el('option', { value: s.id },
        [`${s.name}${s.kind === 'own' ? ' (la finca)' : ''}`]));
    }
    if (selectId) supSelect.value = selectId;
  }
  paintSuppliers();

  // Cherry shows up from a supplier nobody set up yet, and the person at
  // the scale cannot wait for an admin. Creating it here keeps the
  // reception from being written on paper.
  const newSupBtn = el('button', {
    class: 'ctrm-btn ctrm-btn-ghost text-[11px] whitespace-nowrap', type: 'button',
    title: 'Dar de alta un proveedor nuevo',
  }, ['+ Nuevo']);
  newSupBtn.addEventListener('click', async () => {
    const sup = await newSupplierModal();
    if (!sup) return;
    const known = suppliers.find((x) => x.id === sup.id);
    if (!known) {
      suppliers.push(sup);
      suppliers.sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'));
    }
    paintSuppliers(sup.id);
    syncOwn();
  });

  const supplierField = el('div', {}, [
    el('label', { class: 'ctrm-label', text: 'Proveedor' }),
    el('div', { class: 'flex gap-2 items-center' }, [
      el('div', { class: 'flex-1 min-w-0' }, [supSelect]),
      newSupBtn,
    ]),
  ]);
  const dateInput = el('input', { type: 'date', class: 'ctrm-input', value: todayYmd() });
  const stageSelect = el('select', { class: 'ctrm-select' },
    STAGES.map(([v, l]) => el('option', { value: v, selected: v === 'cereza' }, [l])));
  const grossInput = el('input', { type: 'number', min: '0', step: '0.01', class: 'ctrm-input mono', placeholder: '0' });
  const priceInput = el('input', { type: 'number', min: '0', step: '0.01', class: 'ctrm-input mono', placeholder: 'COP por kg' });
  const discInput = el('input', { type: 'number', min: '0', max: '100', step: '0.1', class: 'ctrm-input mono', placeholder: '0' });
  const bpInput = el('input', { type: 'number', min: '0', step: '0.01', class: 'ctrm-input mono', placeholder: '0 si no hubo' });

  const bpWeighed = el('input', { type: 'radio', name: 'bpm', value: 'weighed', checked: true, class: 'mr-1' });
  const bpEstim = el('input', { type: 'radio', name: 'bpm', value: 'estimated', class: 'mr-1' });

  const poolKeys = [...new Set(pools.map((p) => p.pool_key).filter(Boolean))];
  const poolSelect = el('select', { class: 'ctrm-select' }, [
    el('option', { value: '' }, ['Identificado (sin pool)']),
    el('option', { value: 'regional', selected: true }, ['Regional']),
    ...poolKeys.filter((k) => k !== 'regional').map((k) => el('option', { value: k }, [k])),
    el('option', { value: '__new__' }, ['Otro…']),
  ]);
  const poolNewInput = el('input', {
    type: 'text', class: 'ctrm-input mono', placeholder: 'ej: borbon-rosado', hidden: true,
  });
  poolSelect.addEventListener('change', () => {
    if (poolSelect.value === '__new__') poolNewInput.removeAttribute('hidden');
    else poolNewInput.setAttribute('hidden', 'true');
  });

  // Café propio no lleva precio: la regla la impone la base de datos,
  // acá solo se oculta para que nadie lo intente.
  const priceWrap = el('div', {}, [labelled('Precio por kg', priceInput)]);
  const discWrap = el('div', {}, [labelled('Descuento %', discInput)]);
  function syncOwn() {
    const s = suppliers.find((x) => x.id === supSelect.value);
    const isOwn = s && s.kind === 'own';
    for (const w of [priceWrap, discWrap]) {
      if (isOwn) w.setAttribute('hidden', 'true'); else w.removeAttribute('hidden');
    }
    if (isOwn) { priceInput.value = ''; discInput.value = ''; }
    refresh();
  }
  supSelect.addEventListener('change', syncOwn);

  const preview = el('div', { class: 'ctrm-card ctrm-card-pad space-y-1' });

  function refresh() {
    const gross = Number(grossInput.value) || 0;
    const price = priceInput.value === '' ? null : Number(priceInput.value);
    const disc = (Number(discInput.value) || 0) / 100;
    const bp = Number(bpInput.value) || 0;
    const net = Math.max(0, gross - bp);

    clear(preview);
    if (!(gross > 0)) {
      preview.append(el('p', { class: 'text-[12px] text-ink-300 italic',
        text: 'Escribe los kg que llegaron para ver el resumen.' }));
      return;
    }

    const paid = price == null ? null : gross * price * (1 - disc);
    const perNet = paid != null && net > 0 ? paid / net : null;

    preview.append(
      row('kg que llegaron', fmtKg(gross)),
      bp > 0 ? row('Flotes separados', `− ${fmtKg(bp)}`, 'text-crit') : null,
      row('kg netos utilizables', fmtKg(net), 'font-semibold'),
    );
    if (paid != null) {
      preview.append(
        el('div', { class: 'border-t border-sand my-1' }),
        row('Pagado', cop(paid)),
        row('Costo por kg neto', cop(perNet), 'font-semibold text-navy'),
      );
      if (price != null && perNet != null && perNet > price) {
        preview.append(el('p', { class: 'text-[11px] text-ink-500',
          text: `Los flotes encarecen el café bueno: de ${cop(price)} a ${cop(perNet)} por kg.` }));
      }
    } else {
      preview.append(
        el('div', { class: 'border-t border-sand my-1' }),
        el('p', { class: 'text-[11px] text-ink-500',
          text: 'Café de la finca: no lleva precio de compra, se costea con la tarifa T2.' }),
      );
    }

    // La regla de oro: el descuento que empata es el % de flotes.
    if (gross > 0 && bp > 0 && price != null) {
      const bpRate = bp / gross;
      const short = bpRate - disc;
      if (Math.abs(short) < 0.0005) {
        preview.append(alertBox('ok', `Descuento ${pct(disc)} vs flotes ${pct(bpRate)}: quedaste parejo.`));
      } else if (short > 0) {
        preview.append(alertBox('warn',
          `Flotes ${pct(bpRate)} y descuento ${pct(disc)}: te faltaron ${(short * 100).toFixed(1)} puntos para quedar parejo.`));
      } else {
        preview.append(alertBox('ok',
          `Descuento ${pct(disc)} vs flotes ${pct(bpRate)}: ganaste ${(-short * 100).toFixed(1)} puntos.`));
      }
    }
  }
  for (const i of [grossInput, priceInput, discInput, bpInput]) i.addEventListener('input', refresh);

  const saveBtn = el('button', { class: 'ctrm-btn ctrm-btn-primary w-full', type: 'button' }, ['Registrar recepción']);
  saveBtn.addEventListener('click', async () => {
    if (!supSelect.value) { toast('Elige el proveedor', 'warning'); return; }
    const gross = Number(grossInput.value);
    if (!(gross > 0)) { toast('Los kg que llegaron deben ser mayores a 0', 'warning'); return; }

    const s = suppliers.find((x) => x.id === supSelect.value);
    const isOwn = s && s.kind === 'own';
    if (!isOwn && priceInput.value === '') {
      toast('Una compra a un tercero necesita precio por kg', 'warning'); return;
    }

    const bp = Number(bpInput.value) || 0;
    if (bp >= gross) { toast('Los flotes no pueden ser todo lo que llegó', 'warning'); return; }

    let pool_key = poolSelect.value;
    if (pool_key === '__new__') {
      pool_key = poolNewInput.value.trim().toLowerCase();
      if (!pool_key) { toast('Escribe el nombre del pool, o elige Identificado', 'warning'); return; }
    }

    const payload = {
      supplier_id: supSelect.value,
      received_date: dateInput.value,
      entry_stage: stageSelect.value,
      kg_gross: gross,
      pool_key: pool_key || null,
    };
    if (!isOwn) {
      payload.price_per_kg = Number(priceInput.value);
      payload.discount_pct = (Number(discInput.value) || 0) / 100;
    }
    if (bp > 0) {
      payload.byproduct = { kg: bp, measurement: bpEstim.checked ? 'estimated' : 'weighed' };
    }

    try {
      const r = await withBusy(saveBtn, 'Guardando…', () => api.receptionsCreate(payload));
      toast(`Recepción ${r.reception.reception_code} registrada · ${fmtKg(r.reception.kg_net)} netos`, 'success', 5000);
      grossInput.value = ''; priceInput.value = ''; discInput.value = ''; bpInput.value = '';
      await reload();
    } catch (e) {
      toast(e.message || 'No se pudo registrar', 'error', 6000);
    }
  });

  async function reload() {
    const [p, r] = await Promise.all([
      api.costPoolsList({}).catch(() => ({ pools: [] })),
      api.receptionsList({}).catch(() => ({ receptions: [] })),
    ]);
    pools = (p && p.pools) || [];
    receptions = (r && r.receptions) || [];
    redraw();
  }

  function redraw() {
    clear(root);
    root.append(
      el('div', { class: 'grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4' }, [
        el('section', { class: 'ctrm-card ctrm-card-pad space-y-3' }, [
          el('p', { class: 'eyebrow text-[10px]', text: 'Llegó café' }),
          el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-3' }, [
            supplierField,
            labelled('Fecha', dateInput),
            labelled('Entra como', stageSelect),
            labelled('kg que llegaron', grossInput),
          ]),
          el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-3' }, [priceWrap, discWrap]),
          el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-3' }, [
            el('div', {}, [
              labelled('Flotes separados (kg)', bpInput),
              el('div', { class: 'flex gap-3 mt-1 text-[11px] text-ink-500' }, [
                el('label', { class: 'inline-flex items-center' }, [bpWeighed, 'Pesados']),
                el('label', { class: 'inline-flex items-center' }, [bpEstim, 'Estimados']),
              ]),
            ]),
            el('div', {}, [labelled('Pool de costo', poolSelect), poolNewInput]),
          ]),
          saveBtn,
        ]),
        el('div', { class: 'space-y-3' }, [preview, poolsPanel(pools)]),
      ]),
      receptionsTable(receptions),
    );
    refresh();
  }

  syncOwn();
  redraw();

  return chrome(el('div', {}, [
    pageTitle('Recepciones', 'Materia prima que entra a la planta'),
    root,
  ]));
}

function poolsPanel(pools) {
  if (!pools || pools.length === 0) {
    return el('section', { class: 'ctrm-card ctrm-card-pad' }, [
      el('p', { class: 'eyebrow text-[10px] mb-1', text: 'Pools de costo' }),
      el('p', { class: 'text-[12px] text-ink-300 italic', text: 'Sin recepciones en pool todavía.' }),
    ]);
  }
  return el('section', { class: 'ctrm-card ctrm-card-pad space-y-2' }, [
    el('p', { class: 'eyebrow text-[10px]', text: 'Pools de costo' }),
    ...pools.map((p) => el('div', { class: 'border-t border-sand pt-2 first:border-0 first:pt-0' }, [
      el('div', { class: 'flex items-baseline justify-between gap-2' }, [
        el('span', { class: 'font-mono text-[12px] text-navy font-semibold', text: p.pool_key }),
        el('span', { class: 'font-mono text-[12px]', text: `${cop(p.avg_cost_per_kg)} /kg` }),
      ]),
      el('p', { class: 'text-[10px] text-ink-500 font-mono',
        text: `saldo ${fmtKg(p.kg_on_hand)} · recibido ${fmtKg(p.total_received_kg)} · consumido ${fmtKg(p.total_drawn_kg)}` }),
      // La alerta de operación: casi siempre es una recepción sin cargar.
      (p.is_short || p.went_negative)
        ? alertBox('warn', p.is_short
            ? 'Sin saldo: probablemente falta cargar una recepción.'
            : 'Estuvo en negativo en algún momento.')
        : null,
    ])),
  ]);
}

function receptionsTable(receptions) {
  if (!receptions || receptions.length === 0) {
    return el('div', { class: 'ctrm-card ctrm-card-pad mt-4 text-center' }, [
      el('p', { class: 'text-[12px] text-ink-300 italic', text: 'Todavía no hay recepciones registradas.' }),
    ]);
  }

  const cell = (label, classes, content) => {
    const td = el('td', { class: classes });
    td.setAttribute('data-label', label);
    if (content instanceof Node) td.append(content);
    else td.append(document.createTextNode(String(content == null ? '—' : content)));
    return td;
  };
  const bpKg = (r) => Number((r.byproduct_summary && r.byproduct_summary.kg_byproduct) || 0);

  const t = sortableTable({
    headers: [
      { label: 'Código', sortGetter: (r) => r.reception_code },
      { label: 'Fecha', sortGetter: (r) => r.received_date || '' },
      { label: 'Entra', sortGetter: (r) => r.entry_stage },
      { label: 'Bruto', sortGetter: (r) => Number(r.kg_gross || 0), cls: 'text-right' },
      { label: 'Flotes', sortGetter: bpKg, cls: 'text-right' },
      { label: 'Neto', sortGetter: (r) => Number(r.kg_net || 0), cls: 'text-right' },
      { label: 'Pagado', sortGetter: (r) => Number(r.amount_paid_cop || 0), cls: 'text-right' },
      { label: '$/kg neto', sortGetter: (r) => costPerNet(r) ?? -1, cls: 'text-right' },
      { label: 'Pool', sortGetter: (r) => r.pool_key || '' },
    ],
    items: receptions,
    defaultSort: { index: 1, dir: 'desc' },
    totals: [
      { label: 'Total', value: () => 'Total', cls: 'font-semibold text-ink-700' },
      null, null,
      { value: (a) => fmtKg(a.reduce((s, r) => s + Number(r.kg_gross || 0), 0)), cls: 'text-right font-mono' },
      { value: (a) => fmtKg(a.reduce((s, r) => s + bpKg(r), 0)), cls: 'text-right font-mono' },
      { value: (a) => fmtKg(a.reduce((s, r) => s + Number(r.kg_net || 0), 0)), cls: 'text-right font-mono font-semibold' },
      { value: (a) => cop(a.reduce((s, r) => s + Number(r.amount_paid_cop || 0), 0)), cls: 'text-right font-mono font-semibold' },
      null, null,
    ],
    renderRow: (r) => {
      const bs = r.byproduct_summary || {};
      const short = Number(bs.shortfall_pct || 0);
      const perNet = costPerNet(r);
      return el('tr', { class: 'border-t border-sand' }, [
        cell('Código', 'px-2 py-2 font-mono text-[12px] text-navy', r.reception_code),
        cell('Fecha', 'px-2 py-2 font-mono text-[12px]', r.received_date ? fmtDate(r.received_date) : '—'),
        cell('Entra', 'px-2 py-2 text-[12px]', r.entry_stage),
        cell('Bruto', 'px-2 py-2 text-right font-mono', fmtKg(r.kg_gross)),
        cell('Flotes', 'px-2 py-2 text-right font-mono', bpKg(r) > 0
          ? el('span', {}, [
              fmtKg(bs.kg_byproduct),
              el('span', { class: 'text-[10px] text-ink-300', text: ` (${pct(bs.byproduct_pct)})` }),
              bs.has_estimates ? el('span', { class: 'text-[10px] text-ink-300', text: ' est.' }) : null,
            ])
          : '—'),
        cell('Neto', 'px-2 py-2 text-right font-mono font-semibold', fmtKg(r.kg_net)),
        cell('Pagado', 'px-2 py-2 text-right font-mono',
          r.amount_paid_cop == null ? '— propio' : cop(r.amount_paid_cop)),
        cell('$/kg neto', 'px-2 py-2 text-right font-mono',
          perNet == null ? '—' : el('span', { class: short > 0.0005 ? 'text-warn font-semibold' : '' }, [cop(perNet)])),
        cell('Pool', 'px-2 py-2 font-mono text-[11px]', r.pool_key || 'identificado'),
      ]);
    },
  });

  return el('div', { class: 'mt-4' }, [
    el('p', { class: 'eyebrow text-[10px] mb-2', text: 'Recepciones registradas' }),
    t.el,
  ]);
}

function costPerNet(r) {
  const paid = Number(r.amount_paid_cop);
  const net = Number(r.kg_net);
  if (!Number.isFinite(paid) || !(net > 0)) return null;
  return paid / net;
}

function labelled(label, control) {
  return el('div', {}, [el('label', { class: 'ctrm-label', text: label }), control]);
}

function row(label, value, extraCls = '') {
  return el('div', { class: 'flex items-baseline justify-between gap-3 text-[12px]' }, [
    el('span', { class: 'text-ink-500', text: label }),
    el('strong', { class: `font-mono ${extraCls || 'text-ink-700'}`, text: value }),
  ]);
}

function alertBox(kind, text) {
  const style = kind === 'warn'
    ? 'background:#fffbeb;border-color:#fcd34d;color:#92400e;'
    : 'background:#f0fdf4;border-color:#86efac;color:#166534;';
  return el('p', { class: 'text-[11px] rounded-md border px-2 py-1.5 mt-1', style, text });
}

function todayYmd() {
  // Bogotá no tiene horario de verano, así que el offset es fijo.
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Create a supplier without leaving the reception.
 *
 * The farm may only register third parties: 'kind' decides how every
 * lot fed by this supplier gets costed ('own' at the T2 agricultural
 * rate, a third party at the price actually paid), so mislabelling one
 * would quietly cost purchased cherry as if it were the farm's. The
 * server enforces it too — this only keeps the choice off the screen.
 */
function newSupplierModal() {
  const session = getSession();
  const isAdmin = !!(session && session.role === 'admin');

  return openModal(({ close }) => {
    const nameInput = el('input', { type: 'text', class: 'ctrm-input', placeholder: 'ej: Finca La Esperanza', maxlength: '120' });
    const regionInput = el('input', { type: 'text', class: 'ctrm-input', placeholder: 'ej: Manzanares, Caldas', maxlength: '80' });
    const kindSelect = el('select', { class: 'ctrm-select' }, [
      el('option', { value: 'third_party', selected: true }, ['Tercero (le compramos)']),
      el('option', { value: 'own' }, ['Propio (es nuestra finca)']),
    ]);
    const saveBtn = el('button', { class: 'ctrm-btn ctrm-btn-primary', type: 'button' }, ['Crear proveedor']);

    saveBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) { toast('Escribe el nombre del proveedor', 'warning'); return; }
      const payload = {
        name,
        kind: isAdmin ? kindSelect.value : 'third_party',
        region: regionInput.value.trim() || null,
      };
      try {
        const r = await withBusy(saveBtn, 'Creando…', () => api.suppliersCreate(payload));
        toast(r.created ? `Proveedor ${r.supplier.name} creado` : `${r.supplier.name} ya existía, lo seleccioné`,
          'success', 4000);
        close(r.supplier);
      } catch (e) {
        toast(e.message || 'No se pudo crear el proveedor', 'error', 6000);
      }
    });

    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBtn.click(); });

    return el('div', { class: 'space-y-3' }, [
      labelled('Nombre', nameInput),
      labelled('Región (opcional)', regionInput),
      isAdmin
        ? labelled('Tipo', kindSelect)
        : el('p', { class: 'text-[11px] text-ink-500',
            text: 'Se crea como tercero. Un proveedor propio (la finca) solo lo puede crear un admin, porque cambia cómo se costea el café.' }),
      el('div', { class: 'flex justify-end gap-2 pt-1' }, [
        el('button', { class: 'ctrm-btn', type: 'button', onClick: () => close(null) }, ['Cancelar']),
        saveBtn,
      ]),
    ]);
  }, { title: 'Nuevo proveedor' });
}
