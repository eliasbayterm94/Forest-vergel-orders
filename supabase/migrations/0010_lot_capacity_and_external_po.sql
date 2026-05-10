-- 0010 — lot-side over-allocation guard + external PO tracking
--
-- 1) The existing enforce_lot_order_assignment_compat trigger guards
--    per-order over-allocation (sum to one order ≤ kg_green_accepted).
--    This new trigger guards per-lot over-allocation (sum to one lot
--    ≤ kg_green_actual ?? kg_green_expected). Only fires on INSERT or
--    on UPDATE that increases the kg, so operators can always shrink
--    an assignment without being blocked.
--
-- 2) demand_orders gets columns to track the external PO that Forest
--    issues when finca rejects (or partially rejects) an order:
--      external_po_status:   Pendiente | Emitida | Recibida | Cancelada
--      external_po_supplier: free text
--      external_po_code:     alphanumeric reference
--      external_po_date:     date the PO was issued
--      external_po_notes:    free text
--    Existing Rejected/PartiallyAccepted rows are backfilled to
--    'Pendiente' so the externals view shows them as actionable.

-- 1) Lot-side over-allocation trigger
CREATE OR REPLACE FUNCTION enforce_lot_total_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_lot_capacity numeric(12,2);
  v_other_alloc  numeric(12,2);
  v_inserted     boolean;
  v_increasing   boolean;
BEGIN
  v_inserted   := (TG_OP = 'INSERT');
  v_increasing := (TG_OP = 'UPDATE' AND NEW.kg_green_allocated > OLD.kg_green_allocated);
  IF NOT (v_inserted OR v_increasing) THEN RETURN NEW; END IF;

  SELECT COALESCE(kg_green_actual, kg_green_expected)
    INTO v_lot_capacity
    FROM production_lots WHERE id = NEW.production_lot_id;
  IF v_lot_capacity IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(SUM(kg_green_allocated), 0)
    INTO v_other_alloc
    FROM lot_order_assignments
    WHERE production_lot_id = NEW.production_lot_id
      AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

  IF v_other_alloc + NEW.kg_green_allocated > v_lot_capacity + 0.01 THEN
    RAISE EXCEPTION
      'Total lot allocations (%) exceed lot capacity (%) for lot %',
      v_other_alloc + NEW.kg_green_allocated, v_lot_capacity, NEW.production_lot_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_loa_lot_capacity ON lot_order_assignments;
CREATE TRIGGER trg_loa_lot_capacity
BEFORE INSERT OR UPDATE OF kg_green_allocated ON lot_order_assignments
FOR EACH ROW EXECUTE FUNCTION enforce_lot_total_allocation();

-- 2) External PO tracking on demand_orders
ALTER TABLE demand_orders
  ADD COLUMN external_po_status text
    CHECK (external_po_status IS NULL OR external_po_status IN ('Pendiente','Emitida','Recibida','Cancelada')),
  ADD COLUMN external_po_supplier text,
  ADD COLUMN external_po_code text,
  ADD COLUMN external_po_date date,
  ADD COLUMN external_po_notes text;

UPDATE demand_orders
SET external_po_status = 'Pendiente'
WHERE external_po_status IS NULL
  AND status IN ('Rejected','PartiallyAccepted')
  AND (kg_green_required - COALESCE(kg_green_accepted, 0)) > 0;

CREATE INDEX idx_demand_orders_external_po_status ON demand_orders(external_po_status);
