-- ============================================================
-- 0031_partials_p_naming.sql
--
-- Cambia la nomenclatura de parciales de letras (A, B, C, D, E, F)
-- a formato Pn (P1, P2, P3, ..., P99). Relaja el CHECK constraint
-- para aceptar ambos formatos (backwards compat con existentes).
-- ============================================================

ALTER TABLE lot_partials DROP CONSTRAINT IF EXISTS lot_partials_parcial_letter_check;

ALTER TABLE lot_partials
  ADD CONSTRAINT lot_partials_parcial_letter_check
    CHECK (parcial_letter ~ '^(P[0-9]{1,2}|[A-F])$');

COMMENT ON COLUMN lot_partials.parcial_letter IS
  'Identificador del parcial: P1, P2, ... P99 (nuevo) o A-F (legacy).';
