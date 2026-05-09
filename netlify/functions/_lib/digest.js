/**
 * Weekly digest composer — builds the Sunday-night status email sent
 * to all 6 recipients (forest demand creators + farm + admin).
 *
 * Content:
 *   1. Open-orders snapshot (counts + kg sums by status)
 *   2. Urgencies (drying past/red, delivery past/red on in-flight orders)
 *   3. Lots in production (grouped by status)
 *   4. External-PO need (Rejected + PartiallyAccepted remainders)
 *   5. Next-week drying-start lookahead
 *
 * The function is invoked by:
 *   - The scheduled function (Mon 02:00 UTC = Sun 21:00 Bogota)
 *   - The admin manual trigger endpoint
 */

'use strict';

const { greenToCherry } = require('./cherryConversion');
const { latestDryingStartDate, urgencyOf } = require('./leadTime');
const { isoWeekOf, isoWeekKey, isoWeekStart, isoWeekEnd } = require('./isoWeek');
const { bogotaToday, daysBetween, addDays } = require('./bogotaTime');

async function composeWeeklyDigest({ sb, dryingDaysByProcess, todayYmd = bogotaToday() }) {
  // --- Load data ---
  const { data: orders, error: oErr } = await sb
    .from('demand_orders')
    .select(`
      id, order_code, status, kg_green_required, kg_green_accepted,
      max_delivery_date, process_type, physical_aspect, rejection_reason,
      coffee_references ( name )
    `);
  if (oErr) throw new Error(`digest: failed to load orders: ${oErr.message}`);

  const { data: lots, error: lErr } = await sb
    .from('production_lots')
    .select(`
      id, lot_code, status, process_type, kg_cherry_input,
      kg_dried_output, kg_green_actual, kg_green_expected,
      start_date, drying_start_date, ready_date,
      coffee_references ( name )
    `);
  if (lErr) throw new Error(`digest: failed to load lots: ${lErr.message}`);

  // --- Enrich orders with derived fields ---
  const ordersEnriched = (orders || []).map((o) => {
    const ref = (o.coffee_references && o.coffee_references.name) || '—';
    const latest = latestDryingStartDate(o.max_delivery_date, o.process_type, dryingDaysByProcess);
    const deliveryDelta = daysBetween(todayYmd, o.max_delivery_date);
    const deliveryUrgency = deliveryDelta < 0 ? 'past' : (deliveryDelta <= 7 ? 'red' : (deliveryDelta <= 14 ? 'yellow' : 'normal'));
    return {
      ...o,
      reference_name: ref,
      latest_drying_start_date: latest,
      drying_urgency:   urgencyOf(latest, todayYmd),
      delivery_urgency: deliveryUrgency,
      kg_green_required: Number(o.kg_green_required || 0),
      kg_green_accepted: o.kg_green_accepted == null ? null : Number(o.kg_green_accepted),
    };
  });

  const inFlight = ordersEnriched.filter((o) =>
    ['Pending', 'Accepted', 'PartiallyAccepted', 'InProduction'].includes(o.status));

  // --- Buckets ---
  const buckets = {
    Pending:           inFlight.filter((o) => o.status === 'Pending'),
    Accepted:          inFlight.filter((o) => o.status === 'Accepted'),
    PartiallyAccepted: inFlight.filter((o) => o.status === 'PartiallyAccepted'),
    InProduction:      inFlight.filter((o) => o.status === 'InProduction'),
  };

  const sumKgGreen = (arr, key = 'kg_green_accepted') =>
    arr.reduce((s, o) => s + Number(o[key] ?? o.kg_green_required ?? 0), 0);

  const acceptedKgGreen     = sumKgGreen(buckets.Accepted);
  const partialKgGreen      = sumKgGreen(buckets.PartiallyAccepted);
  const inProductionKgGreen = sumKgGreen(buckets.InProduction);

  // --- Urgencies (drying or delivery red/past on in-flight) ---
  const urgencies = inFlight
    .filter((o) =>
      o.drying_urgency === 'past' || o.drying_urgency === 'red'
      || o.delivery_urgency === 'past' || o.delivery_urgency === 'red')
    .sort((a, b) => a.latest_drying_start_date.localeCompare(b.latest_drying_start_date));

  // --- Lots in production (not Delivered) ---
  const activeLots = (lots || []).filter((l) => l.status !== 'Delivered');
  const lotsByStatus = {
    InFermentation: activeLots.filter((l) => l.status === 'InFermentation'),
    Drying:         activeLots.filter((l) => l.status === 'Drying'),
    Resting:        activeLots.filter((l) => l.status === 'Resting'),
    Ready:          activeLots.filter((l) => l.status === 'Ready'),
  };

  // --- External PO need (Rejected and PartiallyAccepted remainder) ---
  const externalRows = ordersEnriched
    .filter((o) => ['Rejected', 'PartiallyAccepted'].includes(o.status))
    .map((o) => ({
      ...o,
      kg_external: Number(o.kg_green_required) - Number(o.kg_green_accepted || 0),
    }))
    .filter((r) => r.kg_external > 0);

  // --- Next-week lookahead (drying-start within current+next ISO week) ---
  const startOfThisWeek = isoWeekStart(todayYmd);
  const endOfNextWeek   = isoWeekEnd(addDays(startOfThisWeek, 7));
  const lookahead = inFlight
    .filter((o) =>
      o.latest_drying_start_date >= startOfThisWeek
      && o.latest_drying_start_date <= endOfNextWeek)
    .sort((a, b) => a.latest_drying_start_date.localeCompare(b.latest_drying_start_date));

  // --- Summary (for log/response) ---
  const { isoYear, isoWeek } = isoWeekOf(todayYmd);
  const summary = {
    today: todayYmd,
    iso_week_key: isoWeekKey(todayYmd),
    counts: {
      pending: buckets.Pending.length,
      accepted: buckets.Accepted.length,
      partially_accepted: buckets.PartiallyAccepted.length,
      in_production: buckets.InProduction.length,
      lots_active: activeLots.length,
      urgencies: urgencies.length,
      external_pos: externalRows.length,
    },
    kg_green: {
      accepted: round2(acceptedKgGreen),
      partial:  round2(partialKgGreen),
      in_production: round2(inProductionKgGreen),
      external_total: round2(externalRows.reduce((s, r) => s + r.kg_external, 0)),
    },
  };

  // --- Render text + html ---
  const subject = `Resumen semanal — Forest ↔ El Vergel — Semana ${isoWeek} ${isoYear}`;
  const text = renderText({ todayYmd, isoYear, isoWeek, buckets, urgencies, lotsByStatus, externalRows, lookahead });
  const html = renderHtml({ todayYmd, isoYear, isoWeek, buckets, urgencies, lotsByStatus, externalRows, lookahead });

  return { subject, text, html, summary };
}

// ---------------------- Renderers ----------------------

function fmtKg(n) {
  return `${(Math.round(Number(n || 0) * 100) / 100).toLocaleString('es-CO', { maximumFractionDigits: 2 })} kg`;
}

function renderText({ todayYmd, isoYear, isoWeek, buckets, urgencies, lotsByStatus, externalRows, lookahead }) {
  const lines = [];
  lines.push('================================================');
  lines.push(`RESUMEN SEMANAL — FOREST ↔ EL VERGEL`);
  lines.push(`Semana ${isoWeek} de ${isoYear}  ·  ${todayYmd}`);
  lines.push('================================================');
  lines.push('');

  lines.push('PEDIDOS ABIERTOS');
  lines.push(`  Pendientes:           ${buckets.Pending.length}`);
  lines.push(`  Aceptados:            ${buckets.Accepted.length}  (${fmtKg(sumGreen(buckets.Accepted))} verde)`);
  lines.push(`  Aceptación parcial:   ${buckets.PartiallyAccepted.length}  (${fmtKg(sumGreen(buckets.PartiallyAccepted))} verde aceptados)`);
  lines.push(`  En producción:        ${buckets.InProduction.length}  (${fmtKg(sumGreen(buckets.InProduction))} verde)`);
  lines.push('');

  lines.push(`URGENCIAS (${urgencies.length})`);
  if (urgencies.length === 0) lines.push('  — Sin urgencias.');
  else for (const o of urgencies) {
    const tag = (o.drying_urgency === 'past' || o.delivery_urgency === 'past') ? 'VENCIDO'
      : 'CRITICO';
    lines.push(`  ${tag}  ${o.order_code}  ${o.reference_name}  drying-start ${o.latest_drying_start_date}  entrega ${o.max_delivery_date}`);
  }
  lines.push('');

  lines.push('LOTES EN PRODUCCION');
  lines.push(`  En fermentación: ${lotsByStatus.InFermentation.length}`);
  lines.push(`  En secado:       ${lotsByStatus.Drying.length}`);
  lines.push(`  En reposo:       ${lotsByStatus.Resting.length}`);
  lines.push(`  Listos:          ${lotsByStatus.Ready.length}`);
  for (const status of ['InFermentation', 'Drying', 'Resting', 'Ready']) {
    for (const l of lotsByStatus[status]) {
      const refName = (l.coffee_references && l.coffee_references.name) || '—';
      const startDate = l.drying_start_date || l.start_date || '—';
      lines.push(`    ${l.lot_code}  ${refName}  ${l.process_type}  ${fmtKg(l.kg_cherry_input)} cereza  desde ${startDate}`);
    }
  }
  lines.push('');

  if (externalRows.length > 0) {
    const tot = externalRows.reduce((s, r) => s + r.kg_external, 0);
    lines.push(`PEDIDOS A SOURCING EXTERNO (${externalRows.length})  total ${fmtKg(tot)} verde`);
    for (const r of externalRows) {
      const tag = r.status === 'Rejected' ? 'rechazado' : 'parcial';
      lines.push(`  ${r.order_code}  ${r.reference_name}  ${tag}  ${fmtKg(r.kg_external)} verde a buscar`);
    }
    lines.push('');
  }

  if (lookahead.length > 0) {
    lines.push('PROXIMOS INICIOS DE SECADO (esta semana + próxima)');
    for (const o of lookahead) {
      lines.push(`  ${o.latest_drying_start_date}  ${o.order_code}  ${o.reference_name}  ${fmtKg(o.kg_green_accepted ?? o.kg_green_required)} verde`);
    }
    lines.push('');
  }

  lines.push('— Forest Production Bridge');
  return lines.join('\n');
}

function renderHtml({ todayYmd, isoYear, isoWeek, buckets, urgencies, lotsByStatus, externalRows, lookahead }) {
  const css = `
    body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#0f172a;background:#f5f7f6;margin:0;padding:0}
    .wrap{max-width:640px;margin:0 auto;padding:16px}
    h1{font-size:18px;color:#072a1f;margin:0 0 4px}
    h2{font-size:14px;color:#0b3d2e;text-transform:uppercase;letter-spacing:.05em;margin:20px 0 8px;border-bottom:1px solid #e5e7eb;padding-bottom:4px}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:12px;margin-bottom:8px}
    .stat{display:inline-block;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:6px 10px;margin:2px;font-size:13px}
    .num{font-weight:600;color:#0b3d2e}
    .past{background:#fee2e2;color:#991b1b;padding:1px 6px;border-radius:6px;font-size:11px;font-weight:600}
    .red{background:#fecaca;color:#7f1d1d;padding:1px 6px;border-radius:6px;font-size:11px;font-weight:600}
    .row{display:flex;justify-content:space-between;gap:8px;font-size:13px;padding:4px 0;border-top:1px dashed #e5e7eb}
    .row:first-of-type{border-top:0}
    .mono{font-family:SFMono-Regular,Menlo,monospace;font-size:12px;background:#f1f5f9;padding:1px 4px;border-radius:4px}
    .muted{color:#64748b;font-size:12px}
    .total{margin-top:8px;font-weight:600;color:#0b3d2e}
  `;
  const sections = [];

  // Header
  sections.push(`
    <div class="card">
      <h1>Resumen semanal — Forest ↔ El Vergel</h1>
      <div class="muted">Semana ${isoWeek} de ${isoYear}  ·  ${todayYmd}</div>
    </div>
  `);

  // Open orders
  sections.push(`
    <h2>Pedidos abiertos</h2>
    <div>
      <span class="stat">Pendientes <span class="num">${buckets.Pending.length}</span></span>
      <span class="stat">Aceptados <span class="num">${buckets.Accepted.length}</span> · ${fmtKg(sumGreen(buckets.Accepted))}</span>
      <span class="stat">Parciales <span class="num">${buckets.PartiallyAccepted.length}</span> · ${fmtKg(sumGreen(buckets.PartiallyAccepted))}</span>
      <span class="stat">En producción <span class="num">${buckets.InProduction.length}</span> · ${fmtKg(sumGreen(buckets.InProduction))}</span>
    </div>
  `);

  // Urgencies
  sections.push(`<h2>Urgencias (${urgencies.length})</h2>`);
  if (urgencies.length === 0) {
    sections.push(`<div class="card muted">Sin urgencias.</div>`);
  } else {
    sections.push(`<div class="card">${urgencies.map((o) => {
      const tag = (o.drying_urgency === 'past' || o.delivery_urgency === 'past')
        ? `<span class="past">VENCIDO</span>`
        : `<span class="red">CRITICO</span>`;
      return `
        <div class="row">
          <div><span class="mono">${esc(o.order_code)}</span> ${esc(o.reference_name)}</div>
          <div>${tag} drying ${o.latest_drying_start_date} · entrega ${o.max_delivery_date}</div>
        </div>
      `;
    }).join('')}</div>`);
  }

  // Lots
  sections.push(`<h2>Lotes en producción</h2>`);
  sections.push(`
    <div>
      <span class="stat">Fermentación <span class="num">${lotsByStatus.InFermentation.length}</span></span>
      <span class="stat">Secado <span class="num">${lotsByStatus.Drying.length}</span></span>
      <span class="stat">Reposo <span class="num">${lotsByStatus.Resting.length}</span></span>
      <span class="stat">Listos <span class="num">${lotsByStatus.Ready.length}</span></span>
    </div>
  `);
  const allActive = ['InFermentation', 'Drying', 'Resting', 'Ready'].flatMap((s) => lotsByStatus[s]);
  if (allActive.length > 0) {
    sections.push(`<div class="card">${allActive.map((l) => `
      <div class="row">
        <div><span class="mono">${esc(l.lot_code)}</span> ${esc((l.coffee_references && l.coffee_references.name) || '—')}</div>
        <div>${esc(l.process_type)} · ${fmtKg(l.kg_cherry_input)} cereza · ${esc(l.status)}</div>
      </div>
    `).join('')}</div>`);
  }

  // External
  if (externalRows.length > 0) {
    const tot = externalRows.reduce((s, r) => s + r.kg_external, 0);
    sections.push(`<h2>Pedidos a sourcing externo (${externalRows.length})</h2>`);
    sections.push(`<div class="card">${externalRows.map((r) => `
      <div class="row">
        <div><span class="mono">${esc(r.order_code)}</span> ${esc(r.reference_name)} · ${esc(r.status === 'Rejected' ? 'rechazado' : 'parcial')}</div>
        <div>${fmtKg(r.kg_external)} verde</div>
      </div>
    `).join('')}<div class="total">Total: ${fmtKg(tot)}</div></div>`);
  }

  // Lookahead
  if (lookahead.length > 0) {
    sections.push(`<h2>Próximos inicios de secado</h2>`);
    sections.push(`<div class="card">${lookahead.map((o) => `
      <div class="row">
        <div><span class="mono">${esc(o.order_code)}</span> ${esc(o.reference_name)}</div>
        <div>${o.latest_drying_start_date} · ${fmtKg(o.kg_green_accepted ?? o.kg_green_required)}</div>
      </div>
    `).join('')}</div>`);
  }

  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="wrap">${sections.join('')}<p class="muted" style="margin-top:24px">— Forest Production Bridge</p></div></body></html>`;
}

function sumGreen(arr) {
  return arr.reduce((s, o) => s + Number(o.kg_green_accepted ?? o.kg_green_required ?? 0), 0);
}
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { composeWeeklyDigest };
