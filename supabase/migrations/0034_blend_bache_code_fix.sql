-- ============================================================
-- 0034_blend_bache_code_fix.sql
--
-- Fix: al crear una mezcla (is_blend=true), el trigger autogeneraba
-- blend_code pero no tocaba bache_code, que es NOT NULL desde la
-- migración 0011. El insert fallaba con:
--   null value in column "bache_code" violates not-null constraint
--
-- Solución: el trigger ahora también setea bache_code = blend_code
-- para las mezclas. Ambas columnas son UNIQUE en su propia columna,
-- así que tener el mismo valor MZ-YYYY-NNNN en las dos es válido.
-- ============================================================

CREATE OR REPLACE FUNCTION set_production_blend_code()
RETURNS trigger AS $$
BEGIN
  IF NEW.is_blend AND (NEW.blend_code IS NULL OR NEW.blend_code = '') THEN
    NEW.blend_code := 'MZ-'
      || EXTRACT(YEAR FROM COALESCE(NEW.created_at, NOW()))::text
      || '-'
      || lpad(nextval('production_lot_blend_seq')::text, 4, '0');
  END IF;
  -- Para mezclas, espejear blend_code en bache_code (NOT NULL).
  IF NEW.is_blend AND (NEW.bache_code IS NULL OR NEW.bache_code = '') THEN
    NEW.bache_code := NEW.blend_code;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
