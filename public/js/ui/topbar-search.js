// Search widget que va al topbar: input + dropdown con resultados de
// pedidos, baches y despachos. Click en un resultado navega a la vista
// correspondiente.

import { el } from './el.js';
import { api } from '../api.js';
import { fmtKg, fmtDate, statusLabel } from './format.js';
import { navigate } from '../router.js';
import { toast } from './toast.js';

const DEBOUNCE_MS = 300;
const MIN_CHARS = 2;

export function topbarSearch() {
  const input = el('input', {
    type: 'search',
    placeholder: 'Buscar pedido, bache, despacho…',
    class: 'topbar-search-input',
    autocomplete: 'off', spellcheck: 'false',
  });

  const dropdown = el('div', { class: 'topbar-search-dropdown', hidden: 'true' });
  let activeRequest = 0;
  let debounce = null;

  function hide() {
    dropdown.setAttribute('hidden', 'true');
    dropdown.innerHTML = '';
  }
  function show() {
    dropdown.removeAttribute('hidden');
  }

  function renderResults(results) {
    dropdown.innerHTML = '';
    const { orders = [], lots = [], shipments = [] } = results;
    const total = orders.length + lots.length + shipments.length;
    if (total === 0) {
      dropdown.append(el('div', { class: 'topbar-search-empty', text: 'Sin resultados' }));
      return;
    }
    if (orders.length > 0) {
      dropdown.append(groupHeader('Pedidos'));
      for (const o of orders) dropdown.append(orderRow(o));
    }
    if (lots.length > 0) {
      dropdown.append(groupHeader('Baches'));
      for (const l of lots) dropdown.append(lotRow(l));
    }
    if (shipments.length > 0) {
      dropdown.append(groupHeader('Despachos'));
      for (const s of shipments) dropdown.append(shipmentRow(s));
    }
  }

  function groupHeader(text) {
    return el('div', { class: 'topbar-search-group', text });
  }

  function orderRow(o) {
    const subParts = [
      o.reference_name || '—',
      o.client_name || null,
      o.contract_code ? `· ${o.contract_code}` : null,
    ].filter(Boolean).join(' ');
    return rowEl({
      code: o.code,
      title: subParts,
      meta: [
        statusLabel(o.status),
        o.kg_green_accepted != null ? fmtKg(o.kg_green_accepted) + ' verde' : null,
        o.max_delivery_date ? `Entrega ${fmtDate(o.max_delivery_date)}` : null,
      ].filter(Boolean).join(' · '),
      onClick: () => goToOrder(o),
    });
  }
  function lotRow(l) {
    return rowEl({
      code: l.code,
      title: `${l.reference_name || '—'} · ${l.process_type || ''}`,
      meta: [
        statusLabel(l.status),
        l.kg_green != null ? fmtKg(l.kg_green) + ' verde' : null,
        l.lot_code !== l.code ? l.lot_code : null,
      ].filter(Boolean).join(' · '),
      onClick: () => goToLot(l),
    });
  }
  function shipmentRow(s) {
    return rowEl({
      code: s.code,
      title: 'Despacho',
      meta: fmtDate(s.shipment_date),
      onClick: () => goToShipment(s),
    });
  }

  function rowEl({ code, title, meta, onClick }) {
    return el('button', {
      type: 'button',
      class: 'topbar-search-row',
      onClick,
    }, [
      el('div', { class: 'topbar-search-row-main' }, [
        el('span', { class: 'topbar-search-code', text: code }),
        el('span', { class: 'topbar-search-title', text: title }),
      ]),
      el('div', { class: 'topbar-search-meta', text: meta }),
    ]);
  }

  function goToOrder(o) {
    closeAndClear();
    // Mejor navegacion segun status. Inbox para pendientes; lots para en
    // produccion; tablero para los demas.
    if (o.status === 'Pending')          navigate('/finca/inbox');
    else if (['Accepted','PartiallyAccepted','InProduction'].includes(o.status))
      navigate('/finca/lots');
    else navigate('/forest/dashboard');
    toast(`Buscando pedido ${o.code}`, 'info', 2000);
  }
  function goToLot(l) {
    closeAndClear();
    if (l.status === 'Delivered') navigate('/finca/despachos');
    else navigate('/finca/lots');
    toast(`Buscando bache ${l.code}`, 'info', 2000);
  }
  function goToShipment(s) {
    closeAndClear();
    navigate('/finca/despachos');
    toast(`Buscando despacho ${s.code}`, 'info', 2000);
  }
  function closeAndClear() {
    input.value = '';
    hide();
  }

  async function runSearch(q) {
    const myReq = ++activeRequest;
    try {
      const r = await api.search(q, 5);
      if (myReq !== activeRequest) return;  // resultado obsoleto
      renderResults(r);
      show();
    } catch (e) {
      if (myReq !== activeRequest) return;
      dropdown.innerHTML = '';
      dropdown.append(el('div', {
        class: 'topbar-search-empty',
        style: 'color:var(--crit);',
        text: e.message || 'Error de búsqueda',
      }));
      show();
    }
  }

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (debounce) clearTimeout(debounce);
    if (q.length < MIN_CHARS) { hide(); return; }
    debounce = setTimeout(() => runSearch(q), DEBOUNCE_MS);
  });

  input.addEventListener('focus', () => {
    if (input.value.trim().length >= MIN_CHARS && dropdown.children.length > 0) show();
  });

  // Cerrar al click fuera
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) hide();
  });

  // Esc cierra
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      hide();
      input.blur();
    }
  });

  const wrap = el('div', { class: 'topbar-search' }, [input, dropdown]);
  return wrap;
}
