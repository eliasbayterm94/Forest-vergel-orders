-- 0010 — lot-side over-allocation guard + external PO tracking
--
-- 1) Trigger: lot-side over-allocation. The previous formulation used
--    COALESCE(NEW.id, ...) to exclude the row being updated from the
--    sum; this got mangled by some clipboard/render paths that wrap
--    "NEW.id" in angle brackets as if it were a placeholder. Reworked
--    to subtract OLD.kg_green_allocated from the full SUM instead, so
--    the SQL never references NEW.id / OLD.id directly.
--
-- 2) demand_orders gets columns to track the external PO that Forest
--    issues when finca rejects (or partially rejects) an order.
--    Backfill: existing Rejected/PartiallyAccepted rows start as
--    'Pendiente' so the externals view shows them as actionable.

-- 1) Lot-side over-allocation trigger
CREATE OR REPLACE FUNCTION enforce_lot_total_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_lot_capacity numeric(12,2);
  v_existing_sum numeric(12,2);
  v_new_total    numeric(12,2);
BEGIN
  -- Only check on INSERT or when an UPDATE increases the kg.
  IF TG_OP = 'UPDATE' AND NEW.kg_green_allocated <= OLD.kg_green_allocated THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(kg_green_actual, kg_green_expected)
    INTO v_lot_capacity
    FROM production_lots WHERE id = NEW.production_lot_id;
  IF v_lot_capacity IS NULL THEN RETURN NEW; END IF;

  -- Sum of all rows in this lot
  SELECT COALESCE(SUM(kg_green_allocated), 0)
    INTO v_existing_sum
    FROM lot_order_assignments
    WHERE production_lot_id = NEW.production_lot_id;

  -- For UPDATE, the row being changed is already in v_existing_sum
  -- with its OLD value; subtract it so we can add the NEW value.
  IF TG_OP = 'UPDATE' THEN
    v_existing_sum := v_existing_sum - OLD.kg_green_allocated;
  END IF;

  v_new_total := v_existing_sum + NEW.kg_green_allocated;

  IF v_new_total > v_lot_capacity + 0.01 THEN
    RAISE EXCEPTION
      'Total lot allocations (%) exceed lot capacity (%) for lot %',
      v_new_total, v_lot_capacity, NEW.production_lot_id;
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
