-- =====================================================================
-- Forest Production Bridge — 0003_production_lots
-- Finca-side production: lots, lot↔variety, lot↔order assignments
-- with kg allocation, status state machine.
-- =====================================================================

-- ---------------------------------------------------------------------
-- production_lots
--
-- Status lifecycle:
--   InFermentation → Drying → Resting → Ready → Delivered
--   (no jumping; enforced by trigger)
--
-- kg_green_expected is set on creation from kg_cherry_input / 7.65
-- by the application layer (single source of truth in the cherry
-- conversion utility). kg_green_actual is captured when the lot
-- transitions to Ready / Delivered.
-- ---------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS production_lot_code_seq START 1;

CREATE TABLE production_lots (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_code             text UNIQUE NOT NULL,

  reference_id         uuid NOT NULL REFERENCES coffee_references(id) ON DELETE RESTRICT,
  process_type         text NOT NULL REFERENCES process_lead_times(process_type) ON UPDATE CASCADE,

  kg_cherry_input      numeric(12,2) NOT NULL CHECK (kg_cherry_input > 0),
  kg_green_expected    numeric(12,2) NOT NULL CHECK (kg_green_expected > 0),
  kg_green_actual      numeric(12,2) CHECK (kg_green_actual IS NULL OR kg_green_actual >= 0),

  status               text NOT NULL DEFAULT 'InFermentation' CHECK (status IN
                         ('InFermentation','Drying','Resting','Ready','Delivered')),

  fermentation_hours   numeric(6,2) CHECK (fermentation_hours IS NULL OR fermentation_hours >= 0),

  start_date           date NOT NULL,                -- cherry receipt / fermentation start
  drying_start_date    date,                         -- when drying actually started
  ready_date           date,
  delivered_date       date,

  notes                text,

  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_production_lots_status       ON production_lots(status);
CREATE INDEX idx_production_lots_reference    ON production_lots(reference_id);
CREATE INDEX idx_production_lots_process_type ON production_lots(process_type);
CREATE INDEX idx_production_lots_start_date   ON production_lots(start_date);

CREATE TRIGGER trg_production_lots_updated_at
BEFORE UPDATE ON production_lots
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Auto-generate lot_code on insert.
-- Format: LOT-{YYYY in Bogota}-{NNNN zero-padded}
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_production_lot_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.lot_code IS NULL OR NEW.lot_code = '' THEN
    NEW.lot_code := 'LOT-'
      || to_char((now() AT TIME ZONE 'America/Bogota')::date, 'YYYY')
      || '-'
      || lpad(nextval('production_lot_code_seq')::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_production_lots_set_code
BEFORE INSERT ON production_lots
FOR EACH ROW EXECUTE FUNCTION set_production_lot_code();

-- ---------------------------------------------------------------------
-- Status-transition enforcement: must move forward one step at a time.
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
    OR (OLD.status = 'Drying'         AND NEW.status = 'Resting')
    OR (OLD.status = 'Resting'        AND NEW.status = 'Ready')
    OR (OLD.status = 'Ready'          AND NEW.status = 'Delivered')
  ) THEN
    RAISE EXCEPTION 'Invalid production_lot status transition: % -> %',
      OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_production_lots_status_transition
BEFORE UPDATE OF status ON production_lots
FOR EACH ROW EXECUTE FUNCTION enforce_production_lot_status_transition();

-- ---------------------------------------------------------------------
-- production_lot_varieties — varieties physically present in the lot
-- ---------------------------------------------------------------------
CREATE TABLE production_lot_varieties (
  production_lot_id uuid NOT NULL REFERENCES production_lots(id) ON DELETE CASCADE,
  variety_id        uuid NOT NULL REFERENCES coffee_varieties(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (production_lot_id, variety_id)
);

CREATE INDEX idx_production_lot_varieties_variety ON production_lot_varieties(variety_id);

-- ---------------------------------------------------------------------
-- lot_order_assignments — many-to-many lot ↔ demand_order with kg
-- allocation. One lot can fulfill several orders (grouping); one order
-- can be fulfilled by several lots.
-- ---------------------------------------------------------------------
CREATE TABLE lot_order_assignments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_lot_id   uuid NOT NULL REFERENCES production_lots(id) ON DELETE CASCADE,
  demand_order_id     uuid NOT NULL REFERENCES demand_orders(id) ON DELETE RESTRICT,
  kg_green_allocated  numeric(12,2) NOT NULL CHECK (kg_green_allocated > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (production_lot_id, demand_order_id)
);

CREATE INDEX idx_loa_lot   ON lot_order_assignments(production_lot_id);
CREATE INDEX idx_loa_order ON lot_order_assignments(demand_order_id);

CREATE TRIGGER trg_loa_updated_at
BEFORE UPDATE ON lot_order_assignments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Compatibility check on assignment: lot.reference must equal order.reference
-- and lot.process_type must equal order.process_type.
-- Also: total allocated kg per order may not exceed kg_green_accepted.
-- ---------------------------------------------------------------------
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

  IF v_lot_ref IS DISTINCT FROM v_ord_ref THEN
    RAISE EXCEPTION 'Lot/order reference mismatch (lot=% order=%)',
      v_lot_ref, v_ord_ref;
  END IF;

  IF v_lot_proc IS DISTINCT FROM v_ord_proc THEN
    RAISE EXCEPTION 'Lot/order process_type mismatch (lot=% order=%)',
      v_lot_proc, v_ord_proc;
  END IF;

  -- Sum allocations including this row (NEW), excluding the prior version on UPDATE.
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

CREATE TRIGGER trg_loa_compat
BEFORE INSERT OR UPDATE ON lot_order_assignments
FOR EACH ROW EXECUTE FUNCTION enforce_lot_order_assignment_compat();
