'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

/**
 * GET /badges
 * Conteos cortos para los pills/badges del chrome (bottom-nav, sidebar).
 * Uno por rol; el cliente decide cuales mostrar.
 *
 * Devuelve:
 *   pending_orders        - pedidos en status Pending (a revisar por finca)
 *   urgent_orders         - pedidos in-flight con drying/delivery rojo o vencido
 *   ready_lots_unshipped  - lotes Ready que no estan en ningun shipment
 */
exports.handler = requireAuth(async (event) => {
  if (event.httpMethod !== 'GET') return methodNotAllowed(['GET']);
  const sb = getSupabase();

  const [pendingR, ordersR, lotsR, shipsR] = await Promise.all([
    sb.from('demand_orders').select('id', { count: 'exact', head: true }).eq('status', 'Pending'),
    // urgentes: usamos el endpoint general de orders, que ya etiqueta
    // urgency en cliente. Aqui un proxy: in-flight con max_delivery_date
    // dentro de los proximos 5 dias o ya pasada.
    sb.from('demand_orders')
      .select('id, max_delivery_date, status')
      .in('status', ['Accepted', 'PartiallyAccepted', 'InProduction']),
    sb.from('production_lots').select('id, status').eq('status', 'Ready'),
    sb.from('shipment_lots').select('production_lot_id'),
  ]);

  if (pendingR.error) return serverErr('pending count failed', pendingR.error.message);
  if (ordersR.error)  return serverErr('urgent lookup failed', ordersR.error.message);
  if (lotsR.error)    return serverErr('ready lookup failed',  lotsR.error.message);
  if (shipsR.error)   return serverErr('ship link lookup failed', shipsR.error.message);

  const today = new Date(); today.setUTCHours(12, 0, 0, 0);
  const urgent = (ordersR.data || []).filter((o) => {
    if (!o.max_delivery_date) return false;
    const dt = new Date(o.max_delivery_date + 'T12:00:00Z');
    const days = (dt - today) / 86400000;
    return days < 5;  // <5d = rojo o vencido
  }).length;

  const shipped = new Set((shipsR.data || []).map((s) => s.production_lot_id));
  const readyUnshipped = (lotsR.data || []).filter((l) => !shipped.has(l.id)).length;

  return ok({
    pending_orders:       pendingR.count || 0,
    urgent_orders:        urgent,
    ready_lots_unshipped: readyUnshipped,
  });
});
