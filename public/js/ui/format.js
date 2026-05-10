// Locale-aware formatting (Spanish, Colombia).
const NF_KG = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });

export const fmtKg     = (n) => `${NF_KG.format(Number(n || 0))} kg`;
export const fmtNumber = (n) => NF_KG.format(Number(n || 0));

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
