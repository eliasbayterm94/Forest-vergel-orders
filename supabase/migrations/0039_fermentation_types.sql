-- ============================================================
-- 0039_fermentation_types.sql
--
-- Tabla administrable de "tipos de fermentación" (los métodos
-- aplicados durante la fermentación): Aeróbico, Anaeróbico, etc.
-- Mismo patrón que drying_types y fermentation_tanks.
--
-- production_lots gana columna fermentation_types text[]
-- (multi-select). Sin CHECK — validación en API.
-- ============================================================

CREATE TABLE IF NOT EXISTS fermentation_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        citext NOT NULL UNIQUE,
  kind        text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_fermentation_types_updated_at
BEFORE UPDATE ON fermentation_types
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed inicial pedido por el usuario
INSERT INTO fermentation_types (name) VALUES
  ('Aeróbico'),
  ('Anaeróbico'),
  ('Maceración Carbónica'),
  ('Láctica'),
  ('Levaduras'),
  ('Infusionado')
ON CONFLICT (name) DO NOTHING;

ALTER TABLE production_lots
  ADD COLUMN IF NOT EXISTS fermentation_types text[] NOT NULL DEFAULT '{}';

COMMENT ON TABLE fermentation_types IS
  'Tipos/métodos de fermentación administrables: Aeróbico, Anaeróbico, etc.';
COMMENT ON COLUMN production_lots.fermentation_types IS
  'Métodos de fermentación aplicados (multi-select). Validado en API.';
