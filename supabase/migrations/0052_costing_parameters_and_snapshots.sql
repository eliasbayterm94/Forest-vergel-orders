-- ============================================================
-- 0052_costing_parameters_and_snapshots.sql   (STAGE 2 of lot costing)
--
-- The costing layer: versioned tariffs, the immutable per-dry-exit
-- cost snapshot, and the monthly close against the mandate.
--
-- PURELY ADDITIVE. No existing table is touched at all.
--
-- ─────────────────────────────────────────────────────────────
-- THE TWO RULES THIS SCHEMA ENFORCES IN THE DATABASE, NOT IN CODE
--
--   1. A snapshot is frozen. Once a lot leaves dry, its cost never
--      changes — not when tariffs are revised, not when the dried
--      weight is corrected later. UPDATE is restricted to the void
--      columns and DELETE is blocked outright, by trigger. Tariff
--      rates are COPIED into the snapshot, so even editing a
--      costing_parameters row cannot reach a snapshot.
--
--   2. Money is derived, never typed twice. total_cost_cop and
--      cost_per_kg_dried are generated columns, so the parts and the
--      total can never disagree.
--
-- A later correction to the dried weight does NOT re-cost the lot:
-- the gap lands in the monthly mandate difference, which is where ops
-- decided it belongs.
-- ============================================================


-- ─── costing_parameters ──────────────────────────────────────
-- Tariffs in force from a date forward. Reviewed quarterly; a new row
-- applies to dry exits on or after its effective_from and never
-- touches what already left.
--
-- There are no per-entry-stage percentages on purpose. T1 is charged
-- FLAT on net kg entering, whatever the stage:
--   · a kg entering already dry yields ~5.7x more finished coffee than
--     a kg of cherry, so a flat charge self-dilutes per kg of finished
--     product and lands within ~27% of a stage-weighted scheme;
--   · and a flat charge makes the monthly close independent of the
--     entry-stage mix — only total volume moves it.
-- The budget denominator must therefore be stated the same way:
-- net kg entering, any stage.
CREATE TABLE IF NOT EXISTS costing_parameters (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_from            date NOT NULL UNIQUE,

  -- COP per kg of NET cherry entering (net = gross minus by-product).
  t1_per_kg_net             numeric(14,4) NOT NULL CHECK (t1_per_kg_net >= 0),
  -- COP per kg of NET own-production cherry. Replaces a purchase price.
  t2_per_kg_own_net         numeric(14,4) NOT NULL CHECK (t2_per_kg_own_net >= 0),

  -- Where the rates came from. Kept so next quarter's review can see
  -- the arithmetic instead of guessing at it.
  annual_mandate_cop        numeric(16,2) CHECK (annual_mandate_cop IS NULL OR annual_mandate_cop >= 0),
  annual_agricultural_cop   numeric(16,2) CHECK (annual_agricultural_cop IS NULL OR annual_agricultural_cop >= 0),
  budget_kg_net             numeric(14,2) CHECK (budget_kg_net IS NULL OR budget_kg_net > 0),
  budget_kg_own_net         numeric(14,2) CHECK (budget_kg_own_net IS NULL OR budget_kg_own_net > 0),

  notes                     text,
  created_by                text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_costing_parameters_effective
  ON costing_parameters (effective_from DESC);

DROP TRIGGER IF EXISTS trg_costing_parameters_updated_at ON costing_parameters;
CREATE TRIGGER trg_costing_parameters_updated_at
BEFORE UPDATE ON costing_parameters
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE costing_parameters ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE costing_parameters IS
  'Versioned costing tariffs. The row in force for a date is the one with the greatest effective_from <= that date. Editing a row never reaches an existing snapshot: snapshots copy the rates.';
COMMENT ON COLUMN costing_parameters.t1_per_kg_net IS
  'T1: processing tariff, COP per kg of NET cherry entering. Charged FLAT regardless of entry stage.';
COMMENT ON COLUMN costing_parameters.t2_per_kg_own_net IS
  'T2: own-production tariff, COP per kg of NET own cherry. Stands in for a purchase price on the farm''s own coffee.';
COMMENT ON COLUMN costing_parameters.budget_kg_net IS
  'Budgeted NET kg entering, any stage — the denominator used to derive T1. Must be measured the same way T1 is charged, or the close carries a permanent bias.';


-- ─── lot_cost_snapshots ──────────────────────────────────────
-- One row per DRY EXIT. Not one per lot: sub-batches each reach Ready
-- on their own date with their own factor, so the unit of costing is
-- the exit, not the batch.
CREATE TABLE IF NOT EXISTS lot_cost_snapshots (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_lot_id      uuid NOT NULL REFERENCES production_lots(id) ON DELETE RESTRICT,

  -- Which tariff version was used, plus the rates copied verbatim.
  costing_parameters_id  uuid REFERENCES costing_parameters(id) ON DELETE RESTRICT,
  t1_per_kg_net          numeric(14,4) NOT NULL CHECK (t1_per_kg_net >= 0),
  t2_per_kg_own_net      numeric(14,4) NOT NULL CHECK (t2_per_kg_own_net >= 0),

  snapshot_date          date NOT NULL,   -- the dry-exit date (ready_date)

  -- Bases, all NET of by-product.
  kg_input_net_total     numeric(12,2) NOT NULL CHECK (kg_input_net_total >= 0),
  kg_input_net_own       numeric(12,2) NOT NULL DEFAULT 0 CHECK (kg_input_net_own >= 0),
  kg_input_net_purchased numeric(12,2) NOT NULL DEFAULT 0 CHECK (kg_input_net_purchased >= 0),
  kg_dried_output        numeric(12,2) NOT NULL CHECK (kg_dried_output >= 0),

  -- kg dried out per kg of net input. NOT the same as the Colombian
  -- factor_rendimiento (kg parchment per 70-kg sack) and the exact
  -- reciprocal of production_lots.conversion_factor. Named in full to
  -- keep the three apart.
  real_factor_dried_per_input numeric(12,6),

  -- Cost breakdown. The monthly close sums these COP amounts straight
  -- from here, so a tariff revision can never move a closed month.
  purchase_cost_cop      numeric(16,2) NOT NULL DEFAULT 0 CHECK (purchase_cost_cop >= 0),
  t2_cost_cop            numeric(16,2) NOT NULL DEFAULT 0 CHECK (t2_cost_cop >= 0),
  t1_cost_cop            numeric(16,2) NOT NULL DEFAULT 0 CHECK (t1_cost_cop >= 0),

  total_cost_cop         numeric(16,2) GENERATED ALWAYS AS
                           (purchase_cost_cop + t2_cost_cop + t1_cost_cop) STORED,
  cost_per_kg_dried      numeric(16,4) GENERATED ALWAYS AS
                           (CASE WHEN kg_dried_output > 0
                                 THEN round((purchase_cost_cop + t2_cost_cop + t1_cost_cop)
                                            / kg_dried_output, 4)
                                 ELSE NULL END) STORED,

  -- How this snapshot came to be:
  --   computed        — the normal path, at dry exit
  --   inherited_blend — weighted average of the blend's components;
  --                     T1 is never re-applied (it would double-count)
  --   split_from      — a parent snapshot scaled by the split ratio;
  --                     cost per kg is identical, it is a share-out
  --   retroactive     — historical lot costed after the fact
  --   adjustment      — a correction pointing at the original
  source_kind            text NOT NULL DEFAULT 'computed'
                           CHECK (source_kind IN ('computed', 'inherited_blend',
                                                  'split_from', 'retroactive', 'adjustment')),
  source_snapshot_id     uuid REFERENCES lot_cost_snapshots(id) ON DELETE RESTRICT,

  -- A snapshot is never deleted. When the dry exit is undone, it is
  -- voided and stays on the record.
  voided_at              timestamptz,
  voided_reason          text,
  voided_by              text,

  notes                  text,
  created_by             text,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lot_cost_snapshots_lot  ON lot_cost_snapshots (production_lot_id);
CREATE INDEX IF NOT EXISTS idx_lot_cost_snapshots_date ON lot_cost_snapshots (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_lot_cost_snapshots_live ON lot_cost_snapshots (snapshot_date)
  WHERE voided_at IS NULL;

-- One live snapshot per lot. A second dry exit (reprocess, or Ready
-- reached again after an undo) must not silently charge the lot twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lot_cost_snapshots_one_live
  ON lot_cost_snapshots (production_lot_id) WHERE voided_at IS NULL;

ALTER TABLE lot_cost_snapshots ENABLE ROW LEVEL SECURITY;

-- Immutability, enforced here rather than trusted to the app.
-- Only the void columns may change; everything else is frozen; DELETE
-- is refused outright.
CREATE OR REPLACE FUNCTION enforce_lot_cost_snapshot_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cost snapshots are never deleted — void them instead (snapshot %)', OLD.id;
  END IF;

  IF (NEW.production_lot_id,      NEW.costing_parameters_id, NEW.t1_per_kg_net,
      NEW.t2_per_kg_own_net,      NEW.snapshot_date,         NEW.kg_input_net_total,
      NEW.kg_input_net_own,       NEW.kg_input_net_purchased, NEW.kg_dried_output,
      NEW.real_factor_dried_per_input, NEW.purchase_cost_cop, NEW.t2_cost_cop,
      NEW.t1_cost_cop,            NEW.source_kind,           NEW.source_snapshot_id,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.production_lot_id,      OLD.costing_parameters_id, OLD.t1_per_kg_net,
      OLD.t2_per_kg_own_net,      OLD.snapshot_date,         OLD.kg_input_net_total,
      OLD.kg_input_net_own,       OLD.kg_input_net_purchased, OLD.kg_dried_output,
      OLD.real_factor_dried_per_input, OLD.purchase_cost_cop, OLD.t2_cost_cop,
      OLD.t1_cost_cop,            OLD.source_kind,           OLD.source_snapshot_id,
      OLD.created_at)
  THEN
    RAISE EXCEPTION 'A cost snapshot is frozen: only voided_at / voided_reason / voided_by may change (snapshot %)', OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lot_cost_snapshots_immutable ON lot_cost_snapshots;
CREATE TRIGGER trg_lot_cost_snapshots_immutable
BEFORE UPDATE OR DELETE ON lot_cost_snapshots
FOR EACH ROW EXECUTE FUNCTION enforce_lot_cost_snapshot_immutable();

COMMENT ON TABLE lot_cost_snapshots IS
  'Frozen cost of one DRY EXIT. Immutable by trigger (only the void columns may change, DELETE refused) and tariffs are copied in, so neither a tariff revision nor a later dried-weight correction can move it. One live snapshot per lot.';


-- ─── monthly_cost_closures ───────────────────────────────────
-- Absorbed vs. the real mandate for the month. The absorbed figures
-- are summed from the snapshots' own COP amounts, so a closed month
-- stays closed even if tariffs change afterwards.
CREATE TABLE IF NOT EXISTS monthly_cost_closures (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year                    integer NOT NULL CHECK (year BETWEEN 2020 AND 2100),
  month                   integer NOT NULL CHECK (month BETWEEN 1 AND 12),

  absorbed_t1_cop         numeric(16,2) NOT NULL DEFAULT 0,
  absorbed_t2_cop         numeric(16,2) NOT NULL DEFAULT 0,
  absorbed_total_cop      numeric(16,2) GENERATED ALWAYS AS
                            (absorbed_t1_cop + absorbed_t2_cop) STORED,

  -- Typed in by ops once a month.
  actual_mandate_cop      numeric(16,2) CHECK (actual_mandate_cop IS NULL OR actual_mandate_cop >= 0),

  mandate_difference_cop  numeric(16,2) GENERATED ALWAYS AS
                            (CASE WHEN actual_mandate_cop IS NULL THEN NULL
                                  ELSE actual_mandate_cop - (absorbed_t1_cop + absorbed_t2_cop)
                             END) STORED,

  -- By-product sale (floater parchment). Carries zero cost, so this is
  -- margin outright; shown next to the difference for the real picture.
  byproduct_revenue_cop   numeric(16,2) CHECK (byproduct_revenue_cop IS NULL OR byproduct_revenue_cop >= 0),

  -- Audit: how many dry exits fed these totals.
  snapshot_count          integer NOT NULL DEFAULT 0 CHECK (snapshot_count >= 0),
  kg_net_processed        numeric(14,2) NOT NULL DEFAULT 0,
  kg_dried_produced       numeric(14,2) NOT NULL DEFAULT 0,

  closed_at               timestamptz,
  closed_by               text,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  UNIQUE (year, month)
);

CREATE INDEX IF NOT EXISTS idx_monthly_cost_closures_period
  ON monthly_cost_closures (year DESC, month DESC);

DROP TRIGGER IF EXISTS trg_monthly_cost_closures_updated_at ON monthly_cost_closures;
CREATE TRIGGER trg_monthly_cost_closures_updated_at
BEFORE UPDATE ON monthly_cost_closures
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE monthly_cost_closures ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE monthly_cost_closures IS
  'Monthly absorbed-vs-mandate close. Absorbed figures are summed from the snapshots'' own COP amounts, so a closed month does not move when tariffs are revised. mandate_difference = actual mandate - absorbed.';
COMMENT ON COLUMN monthly_cost_closures.byproduct_revenue_cop IS
  'Revenue from selling by-product (floater parchment). It carries zero cost — its processing is already inside T1 — so this is margin outright.';
