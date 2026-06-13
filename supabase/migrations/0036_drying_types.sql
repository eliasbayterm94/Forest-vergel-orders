-- ============================================================
-- 0036_drying_types.sql
--
-- Tabla administrable de "tipos de secado" (los equipos/lugares
-- donde se manda a secar el café): Silos, Patio, Nuna, etc.
-- El admin puede agregar/desactivar tipos desde /admin/config.
--
-- kind: clasificación libre (sugeridos: 'Mecánico', 'Natural'),
-- útil para agrupar/etiquetar en la UI. No es enum, para que el
-- admin pueda agregar nuevas categorías sin migración.
--
-- Drop del CHECK rígido que limitaba production_lots.drying_locations
-- a {Silos, Patio}: ahora se valida en la app contra los nombres
-- activos de drying_types.
-- ============================================================

CREATE TABLE IF NOT EXISTS drying_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        citext NOT NULL UNIQUE,
  kind        text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_drying_types_updated_at
BEFORE UPDATE ON drying_types
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Sembrar los dos existentes para no perder selecciones previas.
INSERT INTO drying_types (name, kind) VALUES
  ('Silos', 'Mecánico'),
  ('Patio', 'Natural')
ON CONFLICT (name) DO NOTHING;

-- Relajar el CHECK; ahora la validación vive en la API.
ALTER TABLE production_lots
  DROP CONSTRAINT IF EXISTS drying_locations_valid;

COMMENT ON TABLE drying_types IS
  'Tipos de secado (equipos/lugares) administrables: Silos, Patio, Nuna, etc. La columna kind agrupa por familia (Mecánico/Natural/...) sin enum, libre.';
