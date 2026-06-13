'use strict';

/**
 * Valida y normaliza un array de nombres de tipos de secado.
 * - Trim, dedup, descarta vacíos.
 * - Verifica que TODOS los nombres existan en drying_types (active=true).
 *
 * @returns {Promise<{ ok: true, locations: string[] } | { ok: false, message: string }>}
 */
async function validateDryingLocations(sb, locations) {
  if (!Array.isArray(locations)) {
    return { ok: false, message: 'drying_locations must be array' };
  }
  const cleaned = [...new Set(locations.map((s) => String(s).trim()).filter(Boolean))];
  if (cleaned.length === 0) return { ok: true, locations: cleaned };

  const { data, error } = await sb
    .from('drying_types').select('name').eq('active', true).in('name', cleaned);
  if (error) throw new Error(error.message);
  const validNames = new Set((data || []).map((r) => r.name));
  const invalid = cleaned.filter((n) => !validNames.has(n));
  if (invalid.length > 0) {
    return {
      ok: false,
      message: `drying_locations: tipo(s) inválido(s) "${invalid.join(', ')}". Edita en /admin/config.`,
    };
  }
  return { ok: true, locations: cleaned };
}

module.exports = { validateDryingLocations };
