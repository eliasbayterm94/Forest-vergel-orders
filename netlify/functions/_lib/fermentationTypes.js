'use strict';

/**
 * Valida y normaliza nombres de tipos de fermentación contra la
 * tabla fermentation_types (sólo activos).
 */
async function validateFermentationTypes(sb, types) {
  if (!Array.isArray(types)) {
    return { ok: false, message: 'fermentation_types must be array' };
  }
  const cleaned = [...new Set(types.map((s) => String(s).trim()).filter(Boolean))];
  if (cleaned.length === 0) return { ok: true, types: cleaned };

  const { data, error } = await sb
    .from('fermentation_types').select('name').eq('active', true).in('name', cleaned);
  if (error) throw new Error(error.message);
  const validNames = new Set((data || []).map((r) => r.name));
  const invalid = cleaned.filter((n) => !validNames.has(n));
  if (invalid.length > 0) {
    return {
      ok: false,
      message: `fermentation_types: tipo(s) inválido(s) "${invalid.join(', ')}". Edita en /admin/config.`,
    };
  }
  return { ok: true, types: cleaned };
}

module.exports = { validateFermentationTypes };
