-- ============================================================
-- 0038_fermentation_timing.sql
--
-- 1) fermentation_hours pasa a ser obligatorio (default 0).
--    Los lotes existentes con NULL pasan a 0.
--
-- 2) Dos columnas timestamptz nuevas para precisar día + hora:
--    - fermentation_start_at: cuándo inició realmente la fermentación
--    - drying_start_at:       cuándo salió a secado realmente
--
--    Las horas reales de fermentación se calculan en runtime:
--      (drying_start_at - fermentation_start_at) / 3600 segundos
--
--    Las columnas existentes start_date y drying_start_date (date)
--    se quedan para no romper PDFs, despachos y queries históricas.
--
-- 3) Backfill: a los lotes existentes les inicializo los timestamps
--    desde las fechas (a las 00:00 hora Bogotá). Las horas reales
--    históricas quedan aproximadas (eran solo fechas).
-- ============================================================

-- 1) fermentation_hours NOT NULL DEFAULT 0
UPDATE production_lots SET fermentation_hours = 0 WHERE fermentation_hours IS NULL;
ALTER TABLE production_lots
  ALTER COLUMN fermentation_hours SET DEFAULT 0,
  ALTER COLUMN fermentation_hours SET NOT NULL;

-- 2) Timestamps precisos
ALTER TABLE production_lots
  ADD COLUMN IF NOT EXISTS fermentation_start_at timestamptz,
  ADD COLUMN IF NOT EXISTS drying_start_at       timestamptz;

-- 3) Backfill desde las fechas existentes (Bogotá UTC-5)
UPDATE production_lots
   SET fermentation_start_at = (start_date::text || ' 00:00:00-05')::timestamptz
 WHERE fermentation_start_at IS NULL AND start_date IS NOT NULL;

UPDATE production_lots
   SET drying_start_at = (drying_start_date::text || ' 00:00:00-05')::timestamptz
 WHERE drying_start_at IS NULL AND drying_start_date IS NOT NULL;

COMMENT ON COLUMN production_lots.fermentation_hours IS
  'HORAS PLANIFICADAS de fermentación. Si es 0, el bache nace directo en Secado.';
COMMENT ON COLUMN production_lots.fermentation_start_at IS
  'Instante real de inicio de fermentación. Combina con drying_start_at para calcular las horas reales.';
COMMENT ON COLUMN production_lots.drying_start_at IS
  'Instante real de inicio de secado. NULL hasta que el bache pasa a Drying.';
