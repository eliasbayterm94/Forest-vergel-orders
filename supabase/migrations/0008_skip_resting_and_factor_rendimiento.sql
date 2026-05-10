-- =====================================================================
-- Forest Production Bridge — 0008_skip_resting_and_factor_rendimiento
--
-- Two operational refinements requested by ops:
--
-- 1) Skip the "Resting" stage in the lot lifecycle. The new flow goes
--    straight from Drying to Ready. We keep "Resting" as a valid
--    status in the schema (and in the trigger) so legacy rows still
--    progress; but going forward the UI never moves new lots into it.
--
--      InFermentation → Drying → Ready → Delivered    (new)
--      InFermentation → Drying → Resting → Ready      (legacy still allowed)
--      Ready → Delivered                              (unchanged)
--
-- 2) Per-lot yield factor (Colombian "factor de rendimiento"). At the
--    Ready transition the operator inputs:
--      - kg seco (already stored in production_lots.kg_dried_output)
--      - factor (NEW: production_lots.factor_rendimiento)
--    And kg verde reales is computed as:
--          kg_green_actual = (kg_dried_output / factor) * 70
--    where 70 is the standard kg-per-saco. The formula is
--    process-independent — every lot gets its own factor.
--
--    The per-process dried-to-green divisors from migration 0006
--    remain available as a fallback when no factor is provided
--    (legacy behavior), but the UI now always asks for the factor.
-- =====================================================================

-- 1) factor_rendimiento column
ALTER TABLE production_lots
  ADD COLUMN factor_rendimiento numeric(8,2)
  CHECK (factor_rendimiento IS NULL OR factor_rendimiento > 0);

COMMENT ON COLUMN production_lots.factor_rendimiento IS
  'Colombian factor de rendimiento — kg of dried parchment required to '
  'produce one 70-kg saco of green. kg_green_actual = '
  '(kg_dried_output / factor_rendimiento) * 70.';

-- 2) Update lot status transition trigger to allow Drying → Ready (skip Resting)
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
    OR (OLD.status = 'Resting'        AND NEW.status = 'Ready')
    OR (OLD.status = 'Ready'          AND NEW.status = 'Delivered')
  ) THEN
    RAISE EXCEPTION 'Invalid production_lot status transition: % -> %',
      OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;
