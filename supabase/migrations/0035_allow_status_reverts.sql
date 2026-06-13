-- ============================================================
-- 0035_allow_status_reverts.sql
--
-- Permite "anular paso" en el historial del bache:
--   Drying  → InFermentation
--   Resting → Drying     (ya permitido antes)
--   Ready   → Drying
--   Ready   → Resting
--
-- La validación de qué transiciones se permiten en el flujo normal
-- sigue viviendo en la API (production-lots-update-status.js) que NO
-- expone estas transiciones inversas. El endpoint dedicado
-- lot-undo-stage es el único que dispara estos cambios.
-- ============================================================

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
    OR (OLD.status = 'Drying'         AND NEW.status = 'Resting')
    OR (OLD.status = 'Drying'         AND NEW.status = 'Ready')
    OR (OLD.status = 'Resting'        AND NEW.status = 'Ready')
    OR (OLD.status = 'Resting'        AND NEW.status = 'Drying')
    OR (OLD.status = 'Ready'          AND NEW.status = 'Delivered')
    -- Reversas (sólo desde lot-undo-stage; la API normal sigue
    -- bloqueando estas vías):
    OR (OLD.status = 'Drying'  AND NEW.status = 'InFermentation')
    OR (OLD.status = 'Ready'   AND NEW.status = 'Drying')
    OR (OLD.status = 'Ready'   AND NEW.status = 'Resting')
  ) THEN
    RAISE EXCEPTION 'Invalid production_lot status transition: % -> %',
      OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;
