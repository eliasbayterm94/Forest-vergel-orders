// Locale-aware formatting (Spanish, Colombia).
const NF_KG = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });

export const fmtKg     = (n) => `${NF_KG.format(Number(n || 0))} kg`;
export const fmtNumber = (n) => NF_KG.format(Number(n || 0));

export const INTENSITY_LABEL = {
  media:    'Media',
  alta:     'Alta',
  muy_alta: 'Muy alta',
};
export const fmtIntensity = (v) => (v ? (INTENSITY_LABEL[v] || v) : '');

export function fmtDate(yyyyMmDd) {
  if (!yyyyMmDd) return '—';
  const [y, m, d] = String(yyyyMmDd).split('T')[0].split('-').map(Number);
  if (!y || !m || !d) return yyyyMmDd;
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

const STATUS_LABEL = {
  Pending:           'Pendiente',
  Accepted:          'Aceptado',
  PartiallyAccepted: 'Aceptado parcial',
  Rejected:          'Rechazado',
  InProduction:      'En producción',
  Completed:         'Completado',
  Cancelled:         'Cancelado',
  // Lot statuses
  InFermentation: 'En fermentación',
  Drying:         'Secado',
  Resting:        'Reposo',
  Ready:          'Listo',
  Delivered:      'Entregado',
};
export const statusLabel = (s) => STATUS_LABEL[s] || s;

// Maps each status to a CTRM pill kind (ok | warn | crit | roll | muted)
const STATUS_PILL = {
  Pending:           'warn',
  Accepted:          'ok',
  PartiallyAccepted: 'warn',
  Rejected:          'crit',
  InProduction:      'roll',
  Completed:         'ok',
  Cancelled:         'muted',
  InFermentation:    'roll',
  Drying:            'roll',
  Resting:           'roll',
  Ready:             'ok',
  Delivered:         'muted',
};
export const statusPillKind = (s) => STATUS_PILL[s] || 'muted';

export const URGENCY_LABEL = {
  past:   'Vencido',
  red:    'Crítico',
  yellow: 'Próximo',
  normal: 'OK',
};

/**
 * Tiempo relativo desde un timestamp ISO. "ahora" / "5m" / "2h" / "3d".
 * Para fechas viejas (>7d) cae a MM-DD.
 */
export function relTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diffSec = Math.floor((Date.now() - t) / 1000);
  if (diffSec < 0) return 'en breve';
  if (diffSec < 60) return 'ahora';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d`;
  return new Date(iso).toISOString().slice(5, 10);
}

/**
 * Tiempo relativo a una fecha YYYY-MM-DD (futura o pasada). Devuelve
 * "hoy" / "en 3d" / "hace 5d" / "en 2 sem" / "hace 1 mes".
 */
export function relDate(yyyyMmDd) {
  if (!yyyyMmDd) return '—';
  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);
  const target = new Date(yyyyMmDd + 'T12:00:00Z');
  if (Number.isNaN(target.getTime())) return '—';
  const days = Math.round((target - today) / 86400000);
  if (days === 0)  return 'hoy';
  if (days === 1)  return 'mañana';
  if (days === -1) return 'ayer';
  if (days > 1 && days <= 7)   return `en ${days}d`;
  if (days < -1 && days >= -7) return `hace ${-days}d`;
  if (days > 7 && days <= 60)  return `en ${Math.round(days / 7)} sem`;
  if (days < -7 && days >= -60) return `hace ${Math.round(-days / 7)} sem`;
  if (days > 60)   return `en ${Math.round(days / 30)} mes`;
  if (days < -60)  return `hace ${Math.round(-days / 30)} mes`;
  return '—';
}
