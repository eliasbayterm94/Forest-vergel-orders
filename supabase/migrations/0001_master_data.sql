-- =====================================================================
-- Forest Production Bridge — 0001_master_data
-- Master data: varieties, references, reference↔variety join,
-- process_lead_times config, shared updated_at trigger.
-- =====================================================================

-- Required for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- Shared trigger: keep updated_at fresh on UPDATE
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- coffee_varieties — botanical/cultivar names (e.g. Caturra, Geisha)
-- Names normalized via citext for case-insensitive uniqueness.
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE coffee_varieties (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        citext NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_coffee_varieties_updated_at
BEFORE UPDATE ON coffee_varieties
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- coffee_references — Forest's named coffee references (commercial SKUs)
-- A reference can be a single-variety or a blend of multiple varieties.
-- ---------------------------------------------------------------------
CREATE TABLE coffee_references (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        citext NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_coffee_references_updated_at
BEFORE UPDATE ON coffee_references
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- coffee_reference_varieties — many-to-many: reference ↔ variety
-- Defines which varieties make up each reference (template/expected mix).
-- ---------------------------------------------------------------------
CREATE TABLE coffee_reference_varieties (
  reference_id uuid NOT NULL REFERENCES coffee_references(id) ON DELETE CASCADE,
  variety_id   uuid NOT NULL REFERENCES coffee_varieties(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reference_id, variety_id)
);

CREATE INDEX idx_coffee_reference_varieties_variety ON coffee_reference_varieties(variety_id);

-- ---------------------------------------------------------------------
-- process_lead_times — capacity-engine config
-- drying_days drives latest_drying_start_date back-calculation.
-- One row per process_type. Updatable by admin without code change.
-- ---------------------------------------------------------------------
CREATE TABLE process_lead_times (
  process_type  text PRIMARY KEY
                CHECK (process_type IN ('Natural','Honey','Lavado')),
  drying_days   integer NOT NULL CHECK (drying_days > 0),
  notes         text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_process_lead_times_updated_at
BEFORE UPDATE ON process_lead_times
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed default lead times (conservative max of stated ranges).
INSERT INTO process_lead_times (process_type, drying_days, notes) VALUES
  ('Natural', 12, 'Conservative drying lead time for Natural process.'),
  ('Honey',    8, 'Conservative max of 6–8 day Honey range.'),
  ('Lavado',   8, 'Conservative max of 6–8 day Lavado range.')
ON CONFLICT (process_type) DO NOTHING;
