'use strict';

/**
 * Ajuste de cantidad de un pedido, con aprobación de la finca.
 * Ver migración 0050 para el por qué del modelo.
 *
 * Reglas que cuida este módulo:
 *
 *   · El delta nunca mueve kg_green_required solo. Al aceptarse,
 *     required y accepted se mueven JUNTOS en un único update, para
 *     que chk_status_consistency (migración 0002) nunca se rompa.
 *   · Reducir por debajo de lo ya despachado se rechaza: ese café ya
 *     salió, el pedido no se puede encoger por detrás de la realidad.
 *   · Reducir hasta dejar aceptado en 0 o menos se rechaza: eso es
 *     cancelar el pedido, y para eso existe demand-orders-cancel.
 */

const { LOT_STATUS } = require('./schema');

const MAX_KG = 9999999999.99;   // tope de numeric(12,2)

/**
 * Normaliza el delta que llega por el body.
 * Devuelve { ok:true, value } o { ok:false, message, code }.
 */
function validateDelta(raw) {
  if (raw == null || raw === '') {
    return { ok: false, message: 'delta_kg requerido', code: 'DELTA_REQUIRED' };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, message: 'delta_kg debe ser un número', code: 'DELTA_INVALID' };
  }
  if (n === 0) {
    return { ok: false, message: 'El ajuste no puede ser 0 kg', code: 'DELTA_ZERO' };
  }
  if (Math.abs(n) > MAX_KG) {
    return { ok: false, message: 'delta_kg fuera de rango', code: 'DELTA_OUT_OF_RANGE' };
  }
  // numeric(12,2): redondeamos a 2 decimales para que lo guardado sea
  // exactamente lo que valida esta función.
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/**
 * kg verde ya despachado del pedido: asignaciones cuyos baches están
 * Delivered. Mismo criterio que _lib/orderCompletion.
 */
async function deliveredKgFor(sb, order_id) {
  const { data, error } = await sb
    .from('lot_order_assignments')
    .select('kg_green_allocated, production_lots!inner(status)')
    .eq('demand_order_id', order_id)
    .eq('production_lots.status', LOT_STATUS.Delivered);
  if (error) throw new Error(`Delivered lookup failed: ${error.message}`);
  return (data || []).reduce((s, r) => s + Number(r.kg_green_allocated || 0), 0);
}

/**
 * ¿Es aplicable este delta al pedido? Se usa tanto al pedirlo (para
 * no guardar una solicitud imposible) como al aceptarlo (porque entre
 * los dos momentos pueden haberse despachado kg).
 *
 *   order        — fila con kg_green_required, kg_green_accepted, status
 *   delta        — número ya validado
 *   deliveredKg  — kg verde ya despachado
 *
 * Devuelve { ok:true, next: { kg_green_required, kg_green_accepted } }
 * o { ok:false, message, code }.
 */
function planDelta(order, delta, deliveredKg) {
  const required = Number(order.kg_green_required || 0);
  const nextRequired = round2(required + delta);

  if (nextRequired <= 0) {
    return {
      ok: false,
      code: 'RESULT_NOT_POSITIVE',
      message: `El ajuste dejaría el pedido en ${fmt(nextRequired)} kg. Para anularlo, cancela el pedido.`,
    };
  }

  // Pending: nadie aceptó todavía, así que accepted sigue en NULL y el
  // pedido continúa en el inbox de la finca. Solo se mueve required.
  if (order.kg_green_accepted == null) {
    return { ok: true, next: { kg_green_required: nextRequired } };
  }

  const accepted = Number(order.kg_green_accepted);
  const nextAccepted = round2(accepted + delta);

  if (nextAccepted <= 0) {
    return {
      ok: false,
      code: 'RESULT_NOT_POSITIVE',
      message: `El ajuste dejaría lo aceptado en ${fmt(nextAccepted)} kg. Para anularlo, cancela el pedido.`,
    };
  }

  if (nextAccepted + 1e-6 < deliveredKg) {
    return {
      ok: false,
      code: 'BELOW_DELIVERED',
      message: `Ya se despacharon ${fmt(deliveredKg)} kg de este pedido, así que no puede bajar a ${fmt(nextAccepted)} kg.`,
    };
  }

  return {
    ok: true,
    next: { kg_green_required: nextRequired, kg_green_accepted: nextAccepted },
  };
}

function round2(n) { return Math.round(n * 100) / 100; }
function fmt(n) { return Number(n).toLocaleString('es-CO', { maximumFractionDigits: 2 }); }

/** Campos que limpian la solicitud pendiente. */
const CLEAR_DELTA = Object.freeze({
  kg_green_pending_delta:     null,
  pending_delta_reason:       null,
  pending_delta_requested_at: null,
  pending_delta_requested_by: null,
});

module.exports = {
  MAX_KG, CLEAR_DELTA,
  validateDelta, deliveredKgFor, planDelta, round2,
};
