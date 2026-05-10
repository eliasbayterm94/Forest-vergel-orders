/**
 * Transactional + digest notification orchestration.
 *
 * Recipients are env-driven (comma-separated lists), so they can be
 * changed without redeploys:
 *   EMAIL_RECIPIENTS_DEMAND_CREATOR
 *   EMAIL_RECIPIENTS_FARM
 *   EMAIL_RECIPIENTS_ADMIN
 *
 * For Phase 2 we expose three transactional events; the weekly digest
 * lives with the scheduled function in Phase 5.
 */

'use strict';

const { getSupabase } = require('./supabase');
const { sendEmail, isDryRun } = require('./gmail');
const { greenToCherry } = require('./cherryConversion');

function parseList(envName) {
  const raw = process.env[envName] || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function allRecipients() {
  const merged = new Set([
    ...parseList('EMAIL_RECIPIENTS_DEMAND_CREATOR'),
    ...parseList('EMAIL_RECIPIENTS_FARM'),
    ...parseList('EMAIL_RECIPIENTS_ADMIN'),
  ]);
  return [...merged];
}

// Para eventos donde no quieres notificar a quien lo origino (e.g.
// "pedido creado por Forest" no debe notificar a Forest).
function farmAndAdminRecipients() {
  const merged = new Set([
    ...parseList('EMAIL_RECIPIENTS_FARM'),
    ...parseList('EMAIL_RECIPIENTS_ADMIN'),
  ]);
  return [...merged];
}

async function logEmail({ event_type, to_address, subject, body, related_order_id, status, error_message }) {
  const sb = getSupabase();
  const { error } = await sb.from('email_log').insert({
    event_type, to_address, subject, body, related_order_id, status, error_message,
  });
  if (error) {
    // eslint-disable-next-line no-console
    console.error('email_log insert failed:', error.message);
  }
}

async function dispatch({ event_type, subject, text, html, related_order_id, recipients }) {
  const to = Array.isArray(recipients) ? recipients : allRecipients();
  if (to.length === 0) {
    await logEmail({
      event_type, to_address: '(none configured)', subject, body: text,
      related_order_id, status: 'failed',
      error_message: 'No recipients configured in env vars',
    });
    return { sent: 0, dryRun: isDryRun() };
  }

  let result;
  let status = 'sent';
  let errorMessage = null;
  try {
    result = await sendEmail({ to, subject, text, html });
    if (result.dryRun) status = 'dry_run';
  } catch (err) {
    status = 'failed';
    errorMessage = err && err.message;
  }

  await logEmail({
    event_type,
    to_address: to.join(', '),
    subject,
    body: text,
    related_order_id,
    status,
    error_message: errorMessage,
  });

  return { sent: status === 'sent' ? to.length : 0, dryRun: status === 'dry_run', error: errorMessage };
}

// ----------------------- Templates -----------------------
function fmtKg(n) { return Number(n || 0).toLocaleString('es-CO', { maximumFractionDigits: 2 }); }

function metaLines(order) {
  const out = [];
  if (order.order_type)   out.push(`Tipo: ${order.order_type}`);
  if (order.client_name)  out.push(`Cliente: ${order.client_name}`);
  if (order.regions && order.regions.length) out.push(`Regiones: ${order.regions.join(', ')}`);
  if (order.contract_code) out.push(`Código contrato: ${order.contract_code}`);
  return out;
}

function tplAccepted(order, ref) {
  const partial = order.kg_green_accepted < order.kg_green_required;
  const subject = partial
    ? `[${order.order_code}] Aceptación parcial — ${ref.name}`
    : `[${order.order_code}] Pedido aceptado — ${ref.name}`;
  const text = [
    `Pedido ${order.order_code}`,
    `Referencia: ${ref.name}`,
    ...metaLines(order),
    `Proceso: ${order.process_type}`,
    `Aspecto: ${order.physical_aspect}`,
    `Solicitado: ${fmtKg(order.kg_green_required)} kg verde (${fmtKg(greenToCherry(order.kg_green_required))} kg cereza)`,
    `Aceptado: ${fmtKg(order.kg_green_accepted)} kg verde (${fmtKg(greenToCherry(order.kg_green_accepted))} kg cereza)`,
    partial ? `A buscar externamente: ${fmtKg(order.kg_green_required - order.kg_green_accepted)} kg verde` : '',
    `Fecha máxima de entrega: ${order.max_delivery_date}`,
  ].filter(Boolean).join('\n');
  return { subject, text };
}

function tplRejected(order, ref) {
  const subject = `[${order.order_code}] Pedido rechazado — ${ref.name}`;
  const text = [
    `Pedido ${order.order_code}`,
    `Referencia: ${ref.name}`,
    ...metaLines(order),
    `Proceso: ${order.process_type}`,
    `Solicitado: ${fmtKg(order.kg_green_required)} kg verde`,
    `Estado: RECHAZADO por El Vergel`,
    order.rejection_reason ? `Motivo: ${order.rejection_reason}` : '',
    'Acción Forest: gestionar PO con proveedor externo.',
  ].filter(Boolean).join('\n');
  return { subject, text };
}

function tplCompleted(order, ref) {
  const subject = `[${order.order_code}] Pedido completado — ${ref.name}`;
  const text = [
    `Pedido ${order.order_code}`,
    `Referencia: ${ref.name}`,
    ...metaLines(order),
    `Proceso: ${order.process_type}`,
    `Total entregado: ${fmtKg(order.kg_green_accepted)} kg verde`,
    `Estado: COMPLETADO. Todos los lotes asignados han sido entregados.`,
  ].join('\n');
  return { subject, text };
}

async function notifyDemandAccepted(order, ref) {
  const { subject, text } = tplAccepted(order, ref);
  return dispatch({ event_type: 'demand_accepted', subject, text, related_order_id: order.id });
}
async function notifyDemandRejected(order, ref) {
  const { subject, text } = tplRejected(order, ref);
  return dispatch({ event_type: 'demand_rejected', subject, text, related_order_id: order.id });
}
async function notifyOrderCompleted(order, ref) {
  const { subject, text } = tplCompleted(order, ref);
  return dispatch({ event_type: 'order_completed', subject, text, related_order_id: order.id });
}

module.exports = {
  parseList, allRecipients, farmAndAdminRecipients, dispatch, logEmail,
  notifyDemandAccepted, notifyDemandRejected, notifyOrderCompleted,
};
