'use strict';

/**
 * Valida y normaliza un array de nombres de tanques de fermentación.
 * - Trim, dedup, descarta vacíos.
 * - Verifica que TODOS los nombres existan en fermentation_tanks
 *   con active=true.
 */
async function validateFermentationTanks(sb, tanks) {
  if (!Array.isArray(tanks)) {
    return { ok: false, message: 'fermentation_tanks must be array' };
  }
  const cleaned = [...new Set(tanks.map((s) => String(s).trim()).filter(Boolean))];
  if (cleaned.length === 0) return { ok: true, tanks: cleaned };

  const { data, error } = await sb
    .from('fermentation_tanks').select('name').eq('active', true).in('name', cleaned);
  if (error) throw new Error(error.message);
  const validNames = new Set((data || []).map((r) => r.name));
  const invalid = cleaned.filter((n) => !validNames.has(n));
  if (invalid.length > 0) {
    return {
      ok: false,
      message: `fermentation_tanks: tanque(s) inválido(s) "${invalid.join(', ')}". Edita en /admin/config.`,
    };
  }
  return { ok: true, tanks: cleaned };
}

module.exports = { validateFermentationTanks };
