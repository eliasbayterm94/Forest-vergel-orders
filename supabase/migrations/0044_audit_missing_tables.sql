-- ============================================================
-- 0044_audit_missing_tables.sql
--
-- Los triggers de auditoría (0014) cubrían las 6 tablas core pero
-- quedaron fuera tres tablas que HOY reciben ediciones sensibles:
--
--   lot_resting_cycles    — ciclos de descanso, editables desde el
--                           historial y agregables retroactivamente
--   lot_purchases         — compras directas asignadas a baches
--   lot_blend_components  — componentes de mezclas (kg consumidos)
--
-- Este migration extiende fn_audit_capture (ya existente) a esas
-- tres tablas, y de paso habilita RLS en lot_resting_cycles que
-- quedó sin activar en 0025 (las otras dos ya lo tienen desde sus
-- migrations de origen).
-- ============================================================

ALTER TABLE lot_resting_cycles ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'lot_resting_cycles', 'lot_purchases', 'lot_blend_components'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%1$s ON %1$s', t);
    EXECUTE format(
      'CREATE TRIGGER trg_audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$s
         FOR EACH ROW EXECUTE FUNCTION fn_audit_capture()', t);
  END LOOP;
END $$;
