-- ============================================================
-- 0040_drying_locations_per_cycle.sql
--
-- Hasta ahora `production_lots.drying_locations` se sobreescribía
-- cada vez que el bache volvía a secado desde descanso, perdiendo
-- el equipo del secado anterior. Ahora el secado INICIAL sigue
-- viviendo en production_lots.drying_locations, pero los secados
-- SIGUIENTES (después de cada ciclo de descanso con end_reason=
-- 'back_to_drying') guardan su equipo en
-- lot_resting_cycles.drying_locations_after, así cada fase de
-- secado conserva su propia marquesina/silos.
-- ============================================================

ALTER TABLE lot_resting_cycles
  ADD COLUMN IF NOT EXISTS drying_locations_after text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN lot_resting_cycles.drying_locations_after IS
  'Equipos/marquesinas usados en el secado que arranca DESPUÉS de este ciclo (cuando end_reason=back_to_drying). El secado inicial del bache vive en production_lots.drying_locations.';
