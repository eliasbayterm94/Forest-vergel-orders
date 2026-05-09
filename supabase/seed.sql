-- =====================================================================
-- Forest Production Bridge — seed.sql
-- Idempotent seed for master data. Safe to re-run.
--
-- coffee_varieties: seeded with common Colombian specialty cultivars.
-- coffee_references: intentionally EMPTY. Forest will populate via the
--   inline "+ Crear nueva" flow in the demand form. References are
--   business-specific and should not be invented.
-- process_lead_times: seeded in migration 0001.
-- =====================================================================

INSERT INTO coffee_varieties (name) VALUES
  ('Caturra'),
  ('Castillo'),
  ('Colombia'),
  ('Bourbon'),
  ('Bourbon Rosado'),
  ('Pink Bourbon'),
  ('Geisha'),
  ('Tabi'),
  ('Typica'),
  ('SL28'),
  ('Maragogype'),
  ('Pacamara'),
  ('Wush Wush'),
  ('Sidra'),
  ('Mokka'),
  ('Laurina'),
  ('Java'),
  ('Chiroso'),
  ('Ombligón'),
  ('Cenicafé 1')
ON CONFLICT (name) DO NOTHING;
