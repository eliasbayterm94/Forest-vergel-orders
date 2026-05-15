-- ============================================================
-- 0024_resting_stage_with_humidity.sql
--
-- Re-habilita la etapa de Descanso (Resting) con datos
-- operativos: fecha, humedad. El flujo queda:
--
--   InFermentation → Drying → Descanso (opcional) → Ready → Delivered
--                          \                     /
--                           ↘  Ready directo  ↗
--                              Descanso → Drying (regreso si humedad alta)
--
-- Reglas operativas (las enforza la UI/monitoreo, no la BD):
--   humedad > 20%      → máx 5 días en descanso antes de volver a secado
--   humedad 14% a 20%  → máx 8 días en descanso antes de volver a secado
--   humedad < 14%      → listo para pasar a Ready
--
-- También añade drying_locations (Silos / Patio, multi-select) que
-- se elige cada vez que el bache entra a Drying (incluyendo regreso
-- desde Descanso).
-- ============================================================

ALTER TABLE production_lots
  ADD COLUMN IF NOT EXISTS resting_start_date date,
  ADD COLUMN IF NOT EXISTS resting_humidity   numeric(5,2)
    CHECK (resting_humidity IS NULL OR (resting_humidity >= 8 AND resting_humidity <= 40)),
  ADD COLUMN IF NOT EXISTS drying_locations   text[] NOT NULL DEFAULT '{}';

-- Restringe los valores permitidos dentro de drying_locations.
ALTER TABLE production_lots
  DROP CONSTRAINT IF EXISTS drying_locations_valid;
ALTER TABLE production_lots
  ADD CONSTRAINT drying_locations_valid
  CHECK (drying_locations <@ ARRAY['Silos', 'Patio']::text[]);

COMMENT ON COLUMN production_lots.resting_start_date IS
  'Fecha de inicio de la etapa de Descanso. Solo aplica a baches que pasen por esa etapa (opcional en el flujo).';
COMMENT ON COLUMN production_lots.resting_humidity IS
  'Humedad de control en %. 8-40 válido. Las reglas de tiempo máximo en descanso dependen del valor (lógica en UI/monitoreo).';
COMMENT ON COLUMN production_lots.drying_locations IS
  'Lugares donde se está secando el bache. Multi-select entre {Silos, Patio}. Se actualiza cada vez que el bache entra (o vuelve) a Drying.';

-- ---------------------------------------------------------------------
-- Trigger de transición de estado: re-habilita Drying ↔ Resting y
-- permite el regreso Resting → Drying.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_production_lot_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
       (OLD.status = 'InFermentation' AND NEW.status = 'Drying')
    OR (OLD.status = 'Drying'         AND NEW.status IN ('Resting', 'Ready'))
    OR (OLD.status = 'Resting'        AND NEW.status IN ('Ready', 'Drying'))  -- NEW: regreso a Drying
    OR (OLD.status = 'Ready'          AND NEW.status = 'Delivered')
  ) THEN
    RAISE EXCEPTION 'Invalid production_lot status transition: % -> %',
      OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;
