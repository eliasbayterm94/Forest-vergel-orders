-- 0011 — bache_code on production_lots
--
-- Finca asigna su propio codigo de bache al crear el lote (ej: "B-23",
-- "BACHE-2026-04"). Es obligatorio y unico. Coexiste con lot_code (que
-- sigue siendo el id auto-generado interno LOT-YYYY-NNNN); bache_code
-- pasa a ser el identificador visible para la finca.
--
-- Estrategia: agregar nullable, backfill = lot_code de los lotes
-- existentes, luego endurecer NOT NULL + UNIQUE.

ALTER TABLE production_lots
  ADD COLUMN IF NOT EXISTS bache_code text;

UPDATE production_lots
   SET bache_code = lot_code
 WHERE bache_code IS NULL;

ALTER TABLE production_lots
  ALTER COLUMN bache_code SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'production_lots_bache_code_key'
  ) THEN
    ALTER TABLE production_lots
      ADD CONSTRAINT production_lots_bache_code_key UNIQUE (bache_code);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_production_lots_bache_code
  ON production_lots(bache_code);
