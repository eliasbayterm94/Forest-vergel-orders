'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { LOT_STATUS } = require('./_lib/schema');
const { ok, badReq, conflict, notFound, serverErr, methodNotAllowed, parseJson } = require('./_lib/respond');
const { actorLabel } = require('./_lib/actor');

/**
 * POST /lot-add-resting-cycle  (finca, admin)
 * Body: {
 *   lot_id,
 *   start_date, start_humidity,
 *   end_date, end_humidity, end_reason ('to_ready' | 'back_to_drying'),
 *   reason           // motivo obligatorio, ≥ 10 chars (auditoría)
 * }
 *
 * Agrega un ciclo de descanso RETROACTIVAMENTE a un bache que ya
 * está en Punto Final (Ready). Caso típico: se omitió el registro
 * del descanso mientras corría el proceso, después el operario
 * recupera el dato de la bitácora y lo agrega.
 *
 * Efecto:
 *   · Insert en lot_resting_cycles con cycle_number = max + 1
 *   · Anexa auditoría a notes:
 *       [Ciclo de descanso agregado retroactivamente · <rol> · <fecha>]
 *       Del DD/MM/YYYY al DD/MM/YYYY (X% → Y%). Motivo: ...
 *   · NO cambia status ni ready_date — el bache sigue Ready.
 *
 * Validaciones:
 *   · Status = Ready (Delivered NO — usar herramientas específicas)
 *   · end_date > start_date
 *   · humedades ∈ [8, 40]
 *   · end_reason ∈ {to_ready, back_to_drying}
 *   · reason ≥ 10 chars
 *   · Sugerencia (no bloqueo): start_date ≥ drying_start_date y
 *     end_date ≤ ready_date. Si no encaja, se registra igual pero
 *     el operario ve una advertencia en el modal antes de guardar.
 */
exports.handler = requireAuth(['finca', 'admin'], async (event, _ctx, session) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  let body;
  try { body = parseJson(event); } catch (e) { return badReq(e.message, e.code); }

  const { lot_id } = body || {};
  if (!lot_id) return badReq('lot_id required', 'LOT_ID_REQUIRED');

  const start_date    = body.start_date;
  const end_date      = body.end_date;
  const start_hum_raw = body.start_humidity;
  const end_hum_raw   = body.end_humidity;
  const end_reason    = body.end_reason;
  const reasonTrim    = (body.reason == null ? '' : String(body.reason)).trim().slice(0, 500);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date || '')) return badReq('start_date must be YYYY-MM-DD', 'INVALID_DATE');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end_date   || '')) return badReq('end_date must be YYYY-MM-DD',   'INVALID_DATE');
  if (end_date <= start_date) return badReq('end_date must be > start_date', 'INVALID_RANGE');

  const startHum = Number(start_hum_raw);
  const endHum   = Number(end_hum_raw);
  if (!Number.isFinite(startHum) || startHum < 8 || startHum > 40) {
    return badReq('start_humidity must be between 8 and 40', 'INVALID_HUMIDITY');
  }
  if (!Number.isFinite(endHum) || endHum < 8 || endHum > 40) {
    return badReq('end_humidity must be between 8 and 40', 'INVALID_HUMIDITY');
  }
  if (!['to_ready', 'back_to_drying'].includes(end_reason)) {
    return badReq('end_reason must be to_ready or back_to_drying', 'INVALID_REASON');
  }
  if (reasonTrim.length < 10) {
    return badReq('El motivo debe tener al menos 10 caracteres', 'REASON_TOO_SHORT');
  }

  const sb = getSupabase();
  const { data: lot, error: lErr } = await sb
    .from('production_lots')
    .select('id, status, bache_code, lot_code, drying_start_date, ready_date, notes')
    .eq('id', lot_id).maybeSingle();
  if (lErr) return serverErr('Lookup failed', lErr.message);
  if (!lot) return notFound('Lot not found');
  if (lot.status !== LOT_STATUS.Ready) {
    return conflict(
      `Solo se puede agregar un ciclo de descanso retroactivo a un bache en Listo (actual: ${lot.status}).`,
      'INVALID_STATUS',
    );
  }

  // Próximo cycle_number
  const { data: existing, error: exErr } = await sb
    .from('lot_resting_cycles').select('cycle_number')
    .eq('production_lot_id', lot_id)
    .order('cycle_number', { ascending: false }).limit(1);
  if (exErr) return serverErr('Cycle lookup failed', exErr.message);
  const nextCycle = (existing && existing[0] ? existing[0].cycle_number : 0) + 1;

  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  const { data: inserted, error: insErr } = await sb
    .from('lot_resting_cycles')
    .insert({
      production_lot_id: lot_id,
      cycle_number: nextCycle,
      start_date, start_humidity: round2(startHum),
      end_date,   end_humidity:   round2(endHum),
      end_reason,
    })
    .select().single();
  if (insErr) return serverErr('Insert failed', insErr.message);

  // Auditoría en notes
  const stamp = new Date().toISOString().slice(0, 10);
  const author = actorLabel(session, body);
  const fmt = (ymd) => {
    const [y, m, d] = ymd.split('-');
    return `${d}/${m}/${y}`;
  };
  const auditLine =
    `[Ciclo de descanso agregado retroactivamente · ${author} · ${stamp}] ` +
    `Ciclo ${nextCycle}: ${fmt(start_date)} → ${fmt(end_date)} ` +
    `(${round2(startHum)}% → ${round2(endHum)}%, fin=${end_reason}). ` +
    `Motivo: ${reasonTrim}`;
  const newNotes = lot.notes ? `${lot.notes}\n${auditLine}` : auditLine;
  await sb.from('production_lots').update({ notes: newNotes }).eq('id', lot_id);

  return ok({ cycle: inserted, warnings: buildWarnings(lot, start_date, end_date) });
});

function buildWarnings(lot, start, end) {
  const w = [];
  if (lot.drying_start_date && start < lot.drying_start_date) {
    w.push(`start_date (${start}) es anterior al inicio de secado del bache (${lot.drying_start_date}).`);
  }
  if (lot.ready_date && end > lot.ready_date) {
    w.push(`end_date (${end}) es posterior al cierre del bache (${lot.ready_date}).`);
  }
  return w;
}
