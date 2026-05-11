-- 0021 — infusions catalog + per-lot infusion
--
-- Tabla catalogo de "infusiones" (frutas o aditivos que el lote
-- absorbe en fermentacion / despulpado). Lista crece via app desde
-- la modal de lote.
--
-- En production_lots se agregan dos columnas opcionales:
--   infusion_id  → FK al catalogo (NULL = lote sin infusion)
--   infusion_pct → porcentaje (0,100] sobre el peso del stage de
--                  entrada del lote (kg_cherry_input / kg_despulpado_
--                  input / kg_dried_output segun corresponda)
--
-- Constraint: si infusion_id esta seteado, infusion_pct debe ser > 0;
-- y al reves, si infusion_pct esta seteado debe haber infusion_id.

CREATE TABLE IF NOT EXISTS infusions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text UNIQUE NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text
);

ALTER TABLE infusions ENABLE ROW LEVEL SECURITY;

-- Seed con las opciones que pidio el operador (idempotente).
INSERT INTO infusions (name) VALUES
  ('Fresa'), ('Maracuyá'), ('Cereza'), ('Mango'), ('Banano'), ('Frutos rojos')
ON CONFLICT (name) DO NOTHING;

ALTER TABLE production_lots
  ADD COLUMN IF NOT EXISTS infusion_id  uuid REFERENCES infusions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS infusion_pct numeric(5,2)
    CHECK (infusion_pct IS NULL OR (infusion_pct > 0 AND infusion_pct <= 100));

-- Consistencia: ambos NULL o ambos presentes.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'production_lots_infusion_both_or_none') THEN
    ALTER TABLE production_lots
      ADD CONSTRAINT production_lots_infusion_both_or_none
      CHECK ((infusion_id IS NULL AND infusion_pct IS NULL)
          OR (infusion_id IS NOT NULL AND infusion_pct IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_production_lots_infusion ON production_lots(infusion_id);
