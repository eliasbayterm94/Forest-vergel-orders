-- =====================================================================
-- Forest Production Bridge — 0002_demand_orders
-- Forest-side demand: orders, variety selection, auto order_code,
-- status state machine, partial-accept accounting.
-- =====================================================================

-- ---------------------------------------------------------------------
-- demand_orders — one row per Forest demand request
--
-- Status lifecycle:
--   Pending
--     ├─→ Accepted          (kg_green_accepted = kg_green_required)
--     ├─→ PartiallyAccepted (0 < kg_green_accepted < kg_green_required)
--     ├─→ Rejected          (kg_green_accepted = 0)
--     └─→ Cancelled
--   Accepted | PartiallyAccepted
--     ├─→ InProduction
--     └─→ Cancelled
--   InProduction
--     ├─→ Completed         (sum of delivered allocations >= kg_green_accepted)
--     └─→ Cancelled
--
-- External-supplier remainder (for Forest PO routing) is derived:
--   external_kg = kg_green_required - COALESCE(kg_green_accepted, 0)
--                 when status IN ('PartiallyAccepted','Rejected')
--
-- Cherry conversion (× 7.65) is NOT stored — derived in application
-- layer via a single utility function (single source of truth).
-- ---------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS demand_order_code_seq START 1;
-- ⚠️ Sequence is global, not per-year. Codes look like FV-2026-0001,
-- FV-2026-0002, FV-2027-0003 — the NNNN never resets. Atomic & safe.
-- Flag for future: per-year reset would require advisory locks.

CREATE TABLE demand_orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_code            text UNIQUE NOT NULL,

  reference_id          uuid NOT NULL REFERENCES coffee_references(id) ON DELETE RESTRICT,

  kg_green_required     numeric(12,2) NOT NULL CHECK (kg_green_required > 0),
  kg_green_accepted     numeric(12,2) CHECK (kg_green_accepted IS NULL OR kg_green_accepted >= 0),

  max_delivery_date     date NOT NULL,

  physical_aspect       text NOT NULL CHECK (physical_aspect IN
                          ('Verde','Verde amarillo','Amarillo','Amarillo-Marrón','Parduzco')),
  process_type          text NOT NULL REFERENCES process_lead_times(process_type) ON UPDATE CASCADE,

  fermentation_hours    numeric(6,2) CHECK (fermentation_hours IS NULL OR fermentation_hours >= 0),
  comments              text,

  status                text NOT NULL DEFAULT 'Pending' CHECK (status IN
                          ('Pending','Accepted','PartiallyAccepted','Rejected',
                           'InProduction','Completed','Cancelled')),

  override_15_day       boolean NOT NULL DEFAULT false,
  rejection_reason      text,

  created_by            text,                       -- role label or operator id
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  accepted_at           timestamptz,
  rejected_at           timestamptz,
  in_production_at      timestamptz,
  completed_at          timestamptz,
  cancelled_at          timestamptz,

  CONSTRAINT chk_accepted_le_required
    CHECK (kg_green_accepted IS NULL OR kg_green_accepted <= kg_green_required),

  CONSTRAINT chk_status_consistency CHECK (
    (status = 'Pending'           AND kg_green_accepted IS NULL)
    OR (status = 'Accepted'          AND kg_green_accepted = kg_green_required)
    OR (status = 'PartiallyAccepted' AND kg_green_accepted > 0
                                     AND kg_green_accepted < kg_green_required)
    OR (status = 'Rejected'          AND kg_green_accepted = 0)
    OR status IN ('InProduction','Completed','Cancelled')
  )
);

CREATE INDEX idx_demand_orders_status        ON demand_orders(status);
CREATE INDEX idx_demand_orders_reference     ON demand_orders(reference_id);
CREATE INDEX idx_demand_orders_delivery_date ON demand_orders(max_delivery_date);
CREATE INDEX idx_demand_orders_process_type  ON demand_orders(process_type);

CREATE TRIGGER trg_demand_orders_updated_at
BEFORE UPDATE ON demand_orders
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Auto-generate order_code on insert if not provided.
-- Format: FV-{YYYY in Bogota}-{NNNN zero-padded from sequence}
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_demand_order_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.order_code IS NULL OR NEW.order_code = '' THEN
    NEW.order_code := 'FV-'
      || to_char((now() AT TIME ZONE 'America/Bogota')::date, 'YYYY')
      || '-'
      || lpad(nextval('demand_order_code_seq')::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_demand_orders_set_code
BEFORE INSERT ON demand_orders
FOR EACH ROW EXECUTE FUNCTION set_demand_order_code();

-- ---------------------------------------------------------------------
-- Status-transition enforcement.
-- Any UPDATE that changes status must follow allowed transitions.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_demand_order_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
       (OLD.status = 'Pending'           AND NEW.status IN ('Accepted','PartiallyAccepted','Rejected','Cancelled'))
    OR (OLD.status = 'Accepted'          AND NEW.status IN ('InProduction','Cancelled'))
    OR (OLD.status = 'PartiallyAccepted' AND NEW.status IN ('InProduction','Cancelled'))
    OR (OLD.status = 'InProduction'      AND NEW.status IN ('Completed','Cancelled'))
  ) THEN
    RAISE EXCEPTION 'Invalid demand_order status transition: % -> %',
      OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_demand_orders_status_transition
BEFORE UPDATE OF status ON demand_orders
FOR EACH ROW EXECUTE FUNCTION enforce_demand_order_status_transition();

-- ---------------------------------------------------------------------
-- demand_order_varieties — varieties chosen at demand time
-- (may differ from the reference's default variety mix, e.g. specific blend)
-- ---------------------------------------------------------------------
CREATE TABLE demand_order_varieties (
  demand_order_id uuid NOT NULL REFERENCES demand_orders(id) ON DELETE CASCADE,
  variety_id      uuid NOT NULL REFERENCES coffee_varieties(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (demand_order_id, variety_id)
);

CREATE INDEX idx_demand_order_varieties_variety ON demand_order_varieties(variety_id);
