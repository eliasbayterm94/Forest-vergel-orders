-- =====================================================================
-- Forest Production Bridge — 0006_dried_yield
--
-- Specialty-coffee yield model correction.
--
-- Demand side (forecasting fresh cherry from kg green required) keeps
-- the universal × 7.65 factor in code (cherryConversion.js) — used at
-- demand creation only.
--
-- Delivery side now distinguishes the dried-product weight from green:
--   Natural  → cereza seca:    kg_green = kg_dried_output / 3.4
--   Honey    → pergamino seco: kg_green = kg_dried_output / 1.5
--   Lavado   → pergamino seco: kg_green = kg_dried_output / 1.34
--
-- These divisors live in process_lead_times so they are configurable
-- without code changes; production_lots gets a new kg_dried_output
-- column captured at the end of drying / before dry-milling.
-- =====================================================================

-- 1) Extend process_lead_times with the dried→green divisor.
ALTER TABLE process_lead_times
  ADD COLUMN dried_to_green_divisor numeric(6,4);

UPDATE process_lead_times SET dried_to_green_divisor = 3.40   WHERE process_type = 'Natural';
UPDATE process_lead_times SET dried_to_green_divisor = 1.50   WHERE process_type = 'Honey';
UPDATE process_lead_times SET dried_to_green_divisor = 1.34   WHERE process_type = 'Lavado';

ALTER TABLE process_lead_times
  ALTER COLUMN dried_to_green_divisor SET NOT NULL;

ALTER TABLE process_lead_times
  ADD CONSTRAINT chk_dried_divisor_positive CHECK (dried_to_green_divisor > 0);

-- 2) Track measured dried-product weight on production_lots.
--    Captured at end of drying (or end of resting at the latest);
--    kg_green_actual is then derived as kg_dried_output / divisor.
ALTER TABLE production_lots
  ADD COLUMN kg_dried_output numeric(12,2)
  CHECK (kg_dried_output IS NULL OR kg_dried_output >= 0);
