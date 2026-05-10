-- =====================================================================
-- Forest Production Bridge — 0007_processing_stages_and_reference_fields
--
-- Two domain refinements:
--
-- 1) References (commercial SKUs) carry a default *process_type* and
--    *fermentation_hours* so the demand form auto-fills them. Varieties
--    remain a per-order selection (in demand_order_varieties).
--
-- 2) Production lots can be received at three different processing
--    stages, each with its own conversion factor to green coffee:
--
--      • Cereza fresca (whole fresh cherry):       kg_green = kg / 7.65
--      • Despulpado    (depulped, mucilage / wet):  kg_green = kg / 4.2
--      • Seco           (dried product):             kg_green = kg / 1.34
--
--    These divisors live in the application layer (processYields.js).
--    The DB just records *which* stage the lot was received at and the
--    weight at that stage. The dried-to-green divisors per process
--    (Natural / Honey / Lavado, set in 0006) keep applying at lot
--    delivery time when kg_dried_output is measured.
-- =====================================================================

-- ── 1. Reference template fields ─────────────────────────────────────
ALTER TABLE coffee_references
  ADD COLUMN process_type text REFERENCES process_lead_times(process_type) ON UPDATE CASCADE,
  ADD COLUMN fermentation_hours numeric(6,2)
    CHECK (fermentation_hours IS NULL OR fermentation_hours >= 0);

-- ── 2. Production-lot processing stages ──────────────────────────────
-- 2a. Make kg_cherry_input nullable (lots can now start at any stage).
ALTER TABLE production_lots
  ALTER COLUMN kg_cherry_input DROP NOT NULL;

-- Drop the old strict check and reinstate as conditional
ALTER TABLE production_lots
  DROP CONSTRAINT IF EXISTS production_lots_kg_cherry_input_check;
ALTER TABLE production_lots
  ADD CONSTRAINT production_lots_kg_cherry_input_check
  CHECK (kg_cherry_input IS NULL OR kg_cherry_input > 0);

-- 2b. New column for "café despulpado" wet input weight.
ALTER TABLE production_lots
  ADD COLUMN kg_despulpado_input numeric(12,2)
  CHECK (kg_despulpado_input IS NULL OR kg_despulpado_input > 0);

-- 2c. processing_stage marks at which point the lot was received.
ALTER TABLE production_lots
  ADD COLUMN processing_stage text
  CHECK (processing_stage IS NULL OR processing_stage IN ('cereza','despulpado','seco'));

-- 2d. Backfill existing rows (all created at cereza stage).
UPDATE production_lots
  SET processing_stage = 'cereza'
  WHERE processing_stage IS NULL;

-- 2e. Going forward, a lot must have been received at one of the stages.
ALTER TABLE production_lots
  ADD CONSTRAINT chk_lot_has_input CHECK (
       kg_cherry_input     IS NOT NULL
    OR kg_despulpado_input IS NOT NULL
    OR kg_dried_output     IS NOT NULL
  );
