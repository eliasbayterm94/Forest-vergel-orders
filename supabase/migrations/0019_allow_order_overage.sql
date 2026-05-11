-- 0019 — relax order over-allocation trigger
--
-- Antes el trigger enforce_lot_order_assignment_compat bloqueaba
-- cualquier asignacion cuya suma para un pedido excediera
-- kg_green_accepted. La realidad de produccion permite excedentes
-- (factor de rendimiento mejor del esperado, kg extra que Forest
-- consume al mismo precio). La regla queda: validar referencia +
-- proceso, NO bloquear por sobrecupo. La app marca el excedente
-- visualmente con un pill "Excedente +X kg" en el pedido.
--
-- Sigue vigente:
--   enforce_lot_total_allocation (capacidad fisica del lote — un
--   lote no puede asignar mas kg de los que produjo).

CREATE OR REPLACE FUNCTION enforce_lot_order_assignment_compat()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_lot_ref  uuid;
  v_lot_proc text;
  v_ord_ref  uuid;
  v_ord_proc text;
BEGIN
  SELECT reference_id, process_type INTO v_lot_ref, v_lot_proc
    FROM production_lots WHERE id = NEW.production_lot_id;

  SELECT reference_id, process_type INTO v_ord_ref, v_ord_proc
    FROM demand_orders WHERE id = NEW.demand_order_id;

  IF v_lot_ref IS DISTINCT FROM v_ord_ref THEN
    RAISE EXCEPTION 'Lot/order reference mismatch (lot=% order=%)',
      v_lot_ref, v_ord_ref;
  END IF;

  IF v_lot_proc IS DISTINCT FROM v_ord_proc THEN
    RAISE EXCEPTION 'Lot/order process_type mismatch (lot=% order=%)',
      v_lot_proc, v_ord_proc;
  END IF;

  -- NOTA: ya NO chequeamos sum(kg_green_allocated) <= kg_green_accepted.
  -- El exceso se permite y la app lo visualiza como "Excedente".
  RETURN NEW;
END;
$$;
