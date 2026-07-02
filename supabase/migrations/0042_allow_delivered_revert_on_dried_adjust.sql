-- ============================================================
-- 0042_allow_delivered_revert_on_dried_adjust.sql
--
-- El endpoint /production-lots-adjust-dried permite corregir
-- kg_dried_output post-cierre. Si un bache estaba Delivered y el
-- nuevo valor deja saldo (había más café en bodega no pesado), el
-- endpoint reverte a Ready y limpia delivered_date para que el
-- bache reaparezca en Punto Final con los kg extra.
--
-- El trigger enforce_production_lot_status_transition (última vez
-- redefinido en 0035) NO tenía Delivered→Ready en su whitelist y
-- rechazaba el update con "Invalid production_lot status
-- transition: Delivered -> Ready". Este migration lo permite.
--
-- Justificación operativa: el ajuste de peso post-despacho es un
-- caso legítimo (error de conteo en bodega) y el endpoint ya lo
-- audita en notes + cascade a órdenes vía revertOrdersIfNoLongerComplete.
-- No abrimos la reversa en el flujo normal; sólo lo permite el
-- trigger — la lógica de negocio sigue en el endpoint dedicado.
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
    -- Reversas (sólo desde lot-undo-stage / adjust-dried; el flujo
    -- normal sigue bloqueando estas vías):
    OR (OLD.status = 'Drying'    AND NEW.status = 'InFermentation')
    OR (OLD.status = 'Ready'     AND NEW.status = 'Drying')
    OR (OLD.status = 'Ready'     AND NEW.status = 'Resting')
    OR (OLD.status = 'Delivered' AND NEW.status = 'Ready')
  ) THEN
    RAISE EXCEPTION 'Invalid production_lot status transition: % -> %',
      OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;
