-- ============================================================
-- 0051_costing_inventory.sql   (STAGE 1 of lot costing)
--
-- Raw-material inventory: who we buy from, what came in, what was
-- separated as by-product, and which of it fed each lot.
--
-- This migration is PURELY ADDITIVE. The only change to an existing
-- table is one column on production_lots with a DEFAULT, which in
-- PostgreSQL 11+ is a metadata-only operation (no table rewrite, no
-- lock on the data). Nothing that operations records today changes
-- meaning or stops working.
--
-- Costing itself (tariffs, snapshots, monthly close) lands in 0052.
-- This migration only models the physical facts.
--
-- ─────────────────────────────────────────────────────────────
-- COSTING POLICY THIS SUPPORTS (decided with ops, Oct 2026)
--
--   cost per kg of NET cherry = purchase price      (third party)
--                             | T2                   (own production)
--                             | 0                    (by-product)
--                             + T1                   (always, FLAT)
--
--   · T1 is charged FLAT on net kg entering, whatever the entry
--     stage. No per-stage percentages: a kg entering already dry
--     yields ~5.7x more finished coffee than a kg of cherry, so a
--     flat charge self-dilutes per kg of finished product and lands
--     within ~27% of a stage-weighted scheme — not worth the
--     complexity. Crucially, a flat charge makes the monthly close
--     INDEPENDENT of the entry-stage mix: only total volume moves it.
--     The budget denominator must therefore also be stated as
--     "net kg entering, any stage".
--   · NET = gross minus separated by-product (floaters). The full
--     amount paid is absorbed by the usable coffee, so by-product
--     carries zero cost. Its processing is already baked into T1
--     because the budget denominator excludes it.
--   · Entry prices freeze when the material is drawn into a lot.
--     Tariffs (T1/T2) resolve at dry exit. See 0052.
-- ============================================================


-- ─── suppliers ───────────────────────────────────────────────
-- Every reception has a supplier. The farm itself is one of them,
-- with kind='own': own coffee has no purchase price and is costed
-- with T2 instead.
CREATE TABLE IF NOT EXISTS suppliers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        citext NOT NULL UNIQUE,
  kind        text NOT NULL CHECK (kind IN ('own', 'third_party')),
  region      text,
  active      boolean NOT NULL DEFAULT true,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_suppliers_kind   ON suppliers (kind);
CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers (active);

DROP TRIGGER IF EXISTS trg_suppliers_updated_at ON suppliers;
CREATE TRIGGER trg_suppliers_updated_at
BEFORE UPDATE ON suppliers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE suppliers IS
  'Raw-material suppliers. kind=own is the farm itself (El Vergel): own coffee has no purchase price and is costed with the T2 tariff.';

INSERT INTO suppliers (name, kind, notes) VALUES
  ('El Vergel', 'own', 'La finca. Su café se costea con T2, sin precio de compra.')
ON CONFLICT (name) DO NOTHING;


-- ─── cherry_receptions ───────────────────────────────────────
-- One row per delivery of raw material. kg_gross is what hit the
-- scale; NET is derived from lot_byproducts (single source of truth,
-- so the two numbers cannot drift apart).
--
-- discount_pct: ops pays on gross but may negotiate a discount when a
-- delivery arrives with too many floaters. Break-even rule: the
-- discount that leaves cost per net kg unchanged equals the floater
-- rate exactly.
CREATE SEQUENCE IF NOT EXISTS cherry_reception_code_seq START 1;

CREATE TABLE IF NOT EXISTS cherry_receptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reception_code  text UNIQUE NOT NULL,

  supplier_id     uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  received_date   date NOT NULL,
  entry_stage     text NOT NULL CHECK (entry_stage IN ('cereza', 'despulpado', 'seco')),

  kg_gross        numeric(12,2) NOT NULL CHECK (kg_gross > 0),

  -- NULL required when the supplier is 'own' (enforced by trigger below).
  price_per_kg    numeric(14,4) CHECK (price_per_kg IS NULL OR price_per_kg >= 0),
  discount_pct    numeric(6,4) NOT NULL DEFAULT 0
                    CHECK (discount_pct >= 0 AND discount_pct <= 1),

  -- What was actually paid. Generated so it can never disagree with
  -- its inputs, and so the weighted-average pool reads one column.
  amount_paid_cop numeric(16,2) GENERATED ALWAYS AS (
    CASE WHEN price_per_kg IS NULL THEN NULL
         ELSE round(kg_gross * price_per_kg * (1 - discount_pct), 2)
    END
  ) STORED,

  -- NULL = identified lot (varietals, traced to this very reception).
  -- Set   = joins a weighted-average cost pool under this key, for
  --         material nobody can trace lot-by-lot (regional cherry).
  pool_key        text,

  notes           text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cherry_receptions_supplier ON cherry_receptions (supplier_id);
CREATE INDEX IF NOT EXISTS idx_cherry_receptions_date     ON cherry_receptions (received_date DESC);
CREATE INDEX IF NOT EXISTS idx_cherry_receptions_pool     ON cherry_receptions (pool_key)
  WHERE pool_key IS NOT NULL;

DROP TRIGGER IF EXISTS trg_cherry_receptions_updated_at ON cherry_receptions;
CREATE TRIGGER trg_cherry_receptions_updated_at
BEFORE UPDATE ON cherry_receptions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- reception_code: REC-{YYYY in Bogota}-{NNNN}
CREATE OR REPLACE FUNCTION set_cherry_reception_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.reception_code IS NULL OR NEW.reception_code = '' THEN
    NEW.reception_code := 'REC-'
      || to_char((now() AT TIME ZONE 'America/Bogota')::date, 'YYYY')
      || '-'
      || lpad(nextval('cherry_reception_code_seq')::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cherry_receptions_set_code ON cherry_receptions;
CREATE TRIGGER trg_cherry_receptions_set_code
BEFORE INSERT ON cherry_receptions
FOR EACH ROW EXECUTE FUNCTION set_cherry_reception_code();

-- A price on own coffee, or a missing price on a purchase, would both
-- corrupt the cost. The rule spans two tables, so it needs a trigger
-- rather than a CHECK.
CREATE OR REPLACE FUNCTION enforce_reception_price_by_supplier_kind()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_kind text;
BEGIN
  SELECT kind INTO v_kind FROM suppliers WHERE id = NEW.supplier_id;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'Unknown supplier %', NEW.supplier_id;
  END IF;

  IF v_kind = 'own' AND NEW.price_per_kg IS NOT NULL THEN
    RAISE EXCEPTION 'Own-production receptions carry no purchase price (supplier is kind=own); it is costed with T2';
  END IF;

  IF v_kind = 'third_party' AND NEW.price_per_kg IS NULL THEN
    RAISE EXCEPTION 'A third-party reception needs price_per_kg';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cherry_receptions_price_kind ON cherry_receptions;
CREATE TRIGGER trg_cherry_receptions_price_kind
BEFORE INSERT OR UPDATE OF supplier_id, price_per_kg ON cherry_receptions
FOR EACH ROW EXECUTE FUNCTION enforce_reception_price_by_supplier_kind();

ALTER TABLE cherry_receptions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE cherry_receptions IS
  'One delivery of raw material. kg_gross is what hit the scale; net kg is derived from lot_byproducts so the two can never drift. amount_paid_cop is generated from gross x price x (1-discount).';
COMMENT ON COLUMN cherry_receptions.discount_pct IS
  'Negotiated discount, 0..1. Ops pays on gross but may discount a delivery heavy in floaters. The discount that leaves cost per net kg unchanged equals the floater rate exactly.';
COMMENT ON COLUMN cherry_receptions.pool_key IS
  'NULL = identified (traceable to this reception). Set = joins the weighted-average cost pool under this key, for material that cannot be traced lot-by-lot (regional cherry).';


-- ─── lot_byproducts ──────────────────────────────────────────
-- Floaters and anything else separated out. Zero cost by policy: the
-- whole amount paid is absorbed by the usable coffee. Still traced,
-- because the separated material gets processed and sold.
--
-- Two possible origins because floaters appear both when buying
-- cherry (at the reception) and when building a lot from the farm's
-- own coffee (no purchase reception exists).
CREATE TABLE IF NOT EXISTS lot_byproducts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL DEFAULT 'floaters',

  source_reception_id uuid REFERENCES cherry_receptions(id) ON DELETE CASCADE,
  source_lot_id       uuid REFERENCES production_lots(id) ON DELETE CASCADE,

  -- Where it was weighed. Floaters sent straight to the re-pulper are
  -- often only measurable after depulping, so the stage varies.
  measured_stage      text NOT NULL CHECK (measured_stage IN ('cereza', 'despulpado', 'seco')),
  kg                  numeric(12,2) NOT NULL CHECK (kg > 0),

  -- Sometimes weighed, sometimes a (good) estimate. Reports keep the
  -- two apart so an estimate is never read as a measured fact.
  measurement         text NOT NULL CHECK (measurement IN ('weighed', 'estimated')),

  -- The lot_kind='byproduct' lot that processes this material, once
  -- it exists. NULL while the floaters have not been put to process.
  byproduct_lot_id    uuid REFERENCES production_lots(id) ON DELETE SET NULL,

  separated_on        date NOT NULL,
  notes               text,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_byproduct_exactly_one_source CHECK (
    (source_reception_id IS NOT NULL AND source_lot_id IS NULL)
    OR (source_reception_id IS NULL AND source_lot_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_lot_byproducts_reception ON lot_byproducts (source_reception_id)
  WHERE source_reception_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lot_byproducts_lot       ON lot_byproducts (source_lot_id)
  WHERE source_lot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lot_byproducts_bp_lot    ON lot_byproducts (byproduct_lot_id)
  WHERE byproduct_lot_id IS NOT NULL;

ALTER TABLE lot_byproducts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE lot_byproducts IS
  'By-product separated from a reception or a lot (floaters today; pasilla, cisco later without a migration). Zero cost by policy — the usable coffee absorbs the whole amount paid — but fully traced, because it is processed and sold.';


-- ─── lot_input_sources ───────────────────────────────────────
-- Where each lot's material came from. Several rows per lot, so a lot
-- may mix own and purchased material, or several receptions.
--
-- purchase_cost_per_kg freezes HERE, when the material is drawn: it is
-- a fact, not a tariff. T1/T2 are resolved later, at dry exit, from
-- the versioned tariff in force that day (see 0052).
CREATE TABLE IF NOT EXISTS lot_input_sources (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_lot_id    uuid NOT NULL REFERENCES production_lots(id) ON DELETE CASCADE,

  -- Exactly one of these identifies the origin, per cost_basis below.
  reception_id         uuid REFERENCES cherry_receptions(id) ON DELETE RESTRICT,
  pool_key             text,

  kg                   numeric(12,2) NOT NULL CHECK (kg > 0),
  entry_stage          text NOT NULL CHECK (entry_stage IN ('cereza', 'despulpado', 'seco')),

  cost_basis           text NOT NULL CHECK (cost_basis IN
                         ('purchase_identified', 'purchase_pool', 'own', 'byproduct')),

  -- Frozen purchase price. NULL for own (T2 applies) and by-product (0).
  purchase_cost_per_kg numeric(14,4)
                         CHECK (purchase_cost_per_kg IS NULL OR purchase_cost_per_kg >= 0),

  drawn_at             timestamptz NOT NULL DEFAULT now(),
  notes                text,
  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),

  -- Each basis has exactly one valid shape. Getting this wrong would
  -- silently cost a lot at zero or at the wrong price.
  CONSTRAINT chk_input_source_shape CHECK (
    CASE cost_basis
      WHEN 'purchase_identified' THEN
        reception_id IS NOT NULL AND pool_key IS NULL AND purchase_cost_per_kg IS NOT NULL
      WHEN 'purchase_pool' THEN
        pool_key IS NOT NULL AND purchase_cost_per_kg IS NOT NULL
      WHEN 'own' THEN
        purchase_cost_per_kg IS NULL
      WHEN 'byproduct' THEN
        purchase_cost_per_kg IS NULL
    END
  )
);

CREATE INDEX IF NOT EXISTS idx_lot_input_sources_lot       ON lot_input_sources (production_lot_id);
CREATE INDEX IF NOT EXISTS idx_lot_input_sources_reception ON lot_input_sources (reception_id)
  WHERE reception_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lot_input_sources_pool      ON lot_input_sources (pool_key)
  WHERE pool_key IS NOT NULL;

ALTER TABLE lot_input_sources ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE lot_input_sources IS
  'Where each lot''s material came from: identified reception, cost pool, own production, or by-product. Several rows per lot, so one lot may mix origins. purchase_cost_per_kg freezes at draw time; T1/T2 resolve at dry exit from the versioned tariff.';
COMMENT ON COLUMN lot_input_sources.purchase_cost_per_kg IS
  'Purchase price frozen when the material was drawn. For purchase_pool this is the pool''s weighted average at that moment. NULL for own (T2) and by-product (zero).';


-- ─── production_lots.lot_kind ────────────────────────────────
-- A floater batch IS a production lot: it is depulped, dried, stored
-- and sold as washed parchment. Reusing production_lots gives it the
-- status machine, partials, splits, dispatch and inventory exit for
-- free, instead of a parallel lifecycle.
--
-- DEFAULT 'main' means every existing row keeps its current meaning.
ALTER TABLE production_lots
  ADD COLUMN IF NOT EXISTS lot_kind text NOT NULL DEFAULT 'main';

DO $$
BEGIN
  ALTER TABLE production_lots
    ADD CONSTRAINT chk_production_lots_lot_kind
    CHECK (lot_kind IN ('main', 'byproduct'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_production_lots_lot_kind ON production_lots (lot_kind)
  WHERE lot_kind <> 'main';

COMMENT ON COLUMN production_lots.lot_kind IS
  'main = coffee for sale. byproduct = floaters being processed; carries zero cost and is segmented out of operational and yield views.';
