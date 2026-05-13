-- ============================================================
-- 0023_lot_optional_reference.sql
--
-- Hacer reference_id opcional en production_lots. Refleja el
-- workflow real: la finca produce variedades y procesa baches sin
-- saber a qué pedido irán. La referencia comercial se "adopta"
-- cuando el bache se asigna al primer pedido.
--
-- Cambios:
--   1. production_lots.reference_id pasa a NULL allowed.
--   2. enforce_lot_order_assignment_compat() se relaja: si el lote
--      no tiene referencia, hereda la del pedido (lazy
--      specialization). Si ya tiene referencia, se exige match
--      (comportamiento previo).
-- ============================================================

ALTER TABLE production_lots
  ALTER COLUMN reference_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION enforce_lot_order_assignment_compat()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_lot_ref     uuid;
  v_lot_proc    text;
  v_ord_ref     uuid;
  v_ord_proc    text;
  v_ord_acc     numeric(12,2);
  v_total_alloc numeric(12,2);
BEGIN
  SELECT reference_id, process_type INTO v_lot_ref, v_lot_proc
    FROM production_lots WHERE id = NEW.production_lot_id;

  SELECT reference_id, process_type, COALESCE(kg_green_accepted, 0)
    INTO v_ord_ref, v_ord_proc, v_ord_acc
    FROM demand_orders WHERE id = NEW.demand_order_id;

  -- Lazy specialization: si el bache no tiene referencia y el
  -- pedido sí, el bache la adopta. A partir de aquí queda fija.
  IF v_lot_ref IS NULL AND v_ord_ref IS NOT NULL THEN
    UPDATE production_lots
       SET reference_id = v_ord_ref
     WHERE id = NEW.production_lot_id;
    v_lot_ref := v_ord_ref;
  END IF;

  IF v_lot_ref IS DISTINCT FROM v_ord_ref THEN
    RAISE EXCEPTION 'Lot/order reference mismatch (lot=% order=%)',
      v_lot_ref, v_ord_ref;
  END IF;

  IF v_lot_proc IS DISTINCT FROM v_ord_proc THEN
    RAISE EXCEPTION 'Lot/order process_type mismatch (lot=% order=%)',
      v_lot_proc, v_ord_proc;
  END IF;

  -- Sum allocations incluyendo NEW pero excluyendo la versión previa en UPDATE.
  SELECT COALESCE(SUM(kg_green_allocated), 0)
    INTO v_total_alloc
    FROM lot_order_assignments
    WHERE demand_order_id = NEW.demand_order_id
      AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

  IF v_total_alloc + NEW.kg_green_allocated > v_ord_acc THEN
    RAISE EXCEPTION
      'Total allocated kg (%) exceeds order kg_green_accepted (%) for order %',
      v_total_alloc + NEW.kg_green_allocated, v_ord_acc, NEW.demand_order_id;
  END IF;

  RETURN NEW;
END;
$$;
