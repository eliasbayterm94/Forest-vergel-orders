-- ============================================================
-- 0027_lot_blends.sql
--
-- Mezclas de baches en Punto Final. Una mezcla es un nuevo bache
-- Ready (production_lot con is_blend=true y blend_code MZ-YYYY-NNNN)
-- compuesto por kg seco aportado por uno o más baches "padres".
--
-- Reglas operativas:
--   · Natural solo se mezcla con Natural (mismo proceso).
--   · Honey y Lavado pueden mezclarse entre sí (cualquier combinación H/L).
--   · Las variedades del blend son la unión de las variedades de los padres.
--   · El kg_dried_used de cada componente puede ser todo el kg seco
--     restante del padre (mezcla "completa") o solo parte ("parcial").
--   · kg_dried_disponible del padre = kg_dried_output
--                                       − Σ kg_dried_used en mezclas
--                                       − Σ kg de parciales ya despachados
--     Se calcula en runtime; cuando llega a 0 el bache se oculta del Punto Final.
-- ============================================================

ALTER TABLE production_lots
  ADD COLUMN IF NOT EXISTS is_blend boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS blend_code text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_production_lots_blend_code
  ON production_lots(blend_code) WHERE blend_code IS NOT NULL;

CREATE SEQUENCE IF NOT EXISTS production_lot_blend_seq START 1;

CREATE OR REPLACE FUNCTION set_production_blend_code()
RETURNS trigger AS $$
BEGIN
  IF NEW.is_blend AND (NEW.blend_code IS NULL OR NEW.blend_code = '') THEN
    NEW.blend_code := 'MZ-'
      || EXTRACT(YEAR FROM COALESCE(NEW.created_at, NOW()))::text
      || '-'
      || lpad(nextval('production_lot_blend_seq')::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_set_blend_code
BEFORE INSERT ON production_lots
FOR EACH ROW EXECUTE FUNCTION set_production_blend_code();

CREATE TABLE IF NOT EXISTS lot_blend_components (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blend_lot_id      uuid NOT NULL REFERENCES production_lots(id) ON DELETE CASCADE,
  source_lot_id     uuid NOT NULL REFERENCES production_lots(id),
  kg_dried_used     numeric(12,2) NOT NULL CHECK (kg_dried_used > 0),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_lot_blend_components_blend  ON lot_blend_components(blend_lot_id);
CREATE INDEX idx_lot_blend_components_source ON lot_blend_components(source_lot_id);

ALTER TABLE lot_blend_components ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE lot_blend_components IS
  'Componentes de una mezcla: cada fila enlaza un bache padre y los kg seco aportados al blend.';
COMMENT ON COLUMN production_lots.is_blend IS
  'true si este bache fue creado como mezcla. blend_code se autogenera (MZ-YYYY-NNNN).';
