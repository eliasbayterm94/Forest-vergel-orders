/**
 * Daily digest de pedidos nuevos. Suma todos los demand_orders creados
 * en las ultimas 24h y los reune en un solo email para finca+admin.
 *
 * Diseñado para correr una vez al dia. Si no hay pedidos nuevos en la
 * ventana, devuelve { skip: true } y el caller no manda email.
 */

'use strict';

const { bogotaToday } = require('./bogotaTime');
const { greenToCherry } = require('./cherryConversion');

const WINDOW_HOURS = 24;

function fmtKg(n) { return Number(n || 0).toLocaleString('es-CO', { maximumFractionDigits: 2 }); }

async function composeDailyNewOrdersDigest({ sb, todayYmd = bogotaToday() }) {
  const sinceIso = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();

  const { data: orders, error } = await sb
    .from('demand_orders')
    .select(`
      id, order_code, status, kg_green_required, max_delivery_date,
      process_type, physical_aspect, client_name, contract_code, regions,
      comments, created_at, created_by,
      coffee_references ( name )
    `)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`daily digest: failed to load orders: ${error.message}`);

  const list = orders || [];
  if (list.length === 0) {
    return { skip: true, reason: 'no_new_orders', since: sinceIso };
  }

  const totalKg = list.reduce((s, o) => s + Number(o.kg_green_required || 0), 0);
  const totalCherry = greenToCherry(totalKg);

  const subject = list.length === 1
    ? `[${todayYmd}] 1 pedido nuevo de Forest`
    : `[${todayYmd}] ${list.length} pedidos nuevos de Forest`;

  const lines = [];
  lines.push(`Forest creó ${list.length} pedido${list.length === 1 ? '' : 's'} en las últimas ${WINDOW_HOURS}h.`);
  lines.push(`Total: ${fmtKg(totalKg)} kg verde (${fmtKg(totalCherry)} kg cereza).`);
  lines.push('');
  for (const o of list) {
    const ref = (o.coffee_references && o.coffee_references.name) || '—';
    lines.push(`• ${o.order_code} — ${ref}`);
    lines.push(`    ${fmtKg(o.kg_green_required)} kg verde · ${o.process_type} · entrega ${o.max_delivery_date}`);
    if (o.client_name || o.contract_code) {
      lines.push(`    Cliente: ${o.client_name || '—'}${o.contract_code ? ` · ${o.contract_code}` : ''}`);
    }
    if (o.comments) {
      lines.push(`    Comentarios: ${o.comments}`);
    }
    lines.push('');
  }
  lines.push('Acción El Vergel: revisar y aceptar / rechazar en /finca/inbox.');

  return {
    subject,
    text: lines.join('\n'),
    summary: {
      count: list.length,
      total_kg_green: totalKg,
      total_kg_cherry: totalCherry,
      order_codes: list.map((o) => o.order_code),
    },
  };
}

module.exports = { composeDailyNewOrdersDigest };
