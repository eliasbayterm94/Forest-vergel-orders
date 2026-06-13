-- ============================================================
-- 0037_fermentation_tanks.sql
--
-- Tabla administrable de "tanques de fermentación" (los recipientes
-- donde se está fermentando el café): Tanque 1, Tanque 2, etc.
-- Igual patrón que drying_types: el admin agrega/desactiva/renombra
-- desde /admin/config, y los nombres aparecen como multi-select en
-- el modal de crear lote (single y bulk).
--
-- kind: clasificación libre (sugerencias: 'Plástico', 'Acero',
-- 'Madera'…), útil para agrupar visualmente.
--
-- production_lots gana una columna text[] fermentation_tanks que
-- guarda los nombres elegidos. Sin CHECK — la validación vive en
-- la API y consulta los nombres activos de fermentation_tanks.
-- ============================================================

CREATE TABLE IF NOT EXISTS fermentation_tanks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        citext NOT NULL UNIQUE,
  kind        text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_fermentation_tanks_updated_at
BEFORE UPDATE ON fermentation_tanks
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE production_lots
  ADD COLUMN IF NOT EXISTS fermentation_tanks text[] NOT NULL DEFAULT '{}';

COMMENT ON TABLE fermentation_tanks IS
  'Tanques/recipientes de fermentación administrables. Igual patrón que drying_types.';
COMMENT ON COLUMN production_lots.fermentation_tanks IS
  'Nombres de tanques donde se fermentó el café (multi-select). Validado en API contra fermentation_tanks.active=true.';
