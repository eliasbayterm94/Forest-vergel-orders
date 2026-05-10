-- =====================================================================
-- Forest Production Bridge — 0009_demand_meta_and_shipments
--
-- Two changes:
--
-- 1) Demand orders carry commercial metadata:
--      order_type     — 'Spot' | 'Contract' | 'FOB'
--      client_name    — free text, optional
--      regions        — text[] from {USA, EU, UK, MENA, AU}, optional
--      contract_code  — alphanumeric, optional
--
-- 2) Shipments group lot deliveries. Operator picks 1+ Ready lots
--    (potentially mixing lots that share a reference) into a single
--    despacho. Each lot is then transitioned to Delivered and the
--    existing order-completion cascade runs. The shipment record +
--    its lot links power the printable PDF on the client.
--
--    A lot may belong to at most one shipment (UNIQUE constraint on
--    shipment_lots.production_lot_id).
-- =====================================================================

-- ── 1. Demand metadata ───────────────────────────────────────────────
ALTER TABLE demand_orders
  ADD COLUMN order_type    text CHECK (order_type IS NULL OR order_type IN ('Spot','Contract','FOB')),
  ADD COLUMN client_name   text,
  ADD COLUMN regions       text[],
  ADD COLUMN contract_code text;

-- Helper CHECK on regions array values (only allow the 5 known codes).
ALTER TABLE demand_orders
  ADD CONSTRAINT chk_regions_known
  CHECK (
    regions IS NULL
    OR regions <@ ARRAY['USA','EU','UK','MENA','AU']::text[]
  );

CREATE INDEX idx_demand_orders_order_type    ON demand_orders(order_type);
CREATE INDEX idx_demand_orders_client_name   ON demand_orders(client_name);
CREATE INDEX idx_demand_orders_contract_code ON demand_orders(contract_code);

-- ── 2. Shipments ─────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS shipment_code_seq START 1;

CREATE TABLE shipments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_code text UNIQUE NOT NULL,
  shipment_date date NOT NULL DEFAULT current_date,
  notes         text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Auto-generate shipment_code: DSP-{YYYY in Bogota}-{NNNN}
CREATE OR REPLACE FUNCTION set_shipment_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.shipment_code IS NULL OR NEW.shipment_code = '' THEN
    NEW.shipment_code := 'DSP-'
      || to_char((now() AT TIME ZONE 'America/Bogota')::date, 'YYYY')
      || '-'
      || lpad(nextval('shipment_code_seq')::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_shipments_set_code
BEFORE INSERT ON shipments
FOR EACH ROW EXECUTE FUNCTION set_shipment_code();

CREATE INDEX idx_shipments_date ON shipments(shipment_date DESC);

-- Link table (one lot belongs to at most one shipment)
CREATE TABLE shipment_lots (
  shipment_id       uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  production_lot_id uuid NOT NULL REFERENCES production_lots(id) ON DELETE RESTRICT,
  PRIMARY KEY (shipment_id, production_lot_id),
  UNIQUE (production_lot_id)   -- a lot ships at most once
);

CREATE INDEX idx_shipment_lots_lot ON shipment_lots(production_lot_id);

-- RLS deny-all to anon (server uses service_role)
ALTER TABLE shipments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_lots  ENABLE ROW LEVEL SECURITY;
