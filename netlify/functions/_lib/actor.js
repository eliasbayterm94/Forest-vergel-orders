'use strict';

/**
 * Etiqueta de actor para tags de auditoría en notes.
 * El login es por rol compartido; el operario individual viaja como
 * body.operator_name (lo inyecta el API client desde el selector
 * del sidebar). Resultado: "finca (Juan P.)" o solo "finca" si no
 * hay operario elegido.
 */
function actorLabel(session, body) {
  const role = (session && session.role) || 'unknown';
  const raw = body && typeof body.operator_name === 'string' ? body.operator_name.trim() : '';
  const op = raw.slice(0, 60);
  return op ? `${role} (${op})` : role;
}

module.exports = { actorLabel };
