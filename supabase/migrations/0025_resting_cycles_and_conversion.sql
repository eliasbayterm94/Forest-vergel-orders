-- ============================================================
-- 0025_resting_cycles_and_conversion.sql
--
-- Tres mejoras operativas:
--
-- 1. Histórico de descansos: un bache puede entrar y salir de
--    Descanso varias veces. Necesitamos saber cuántos descansos
--    lleva y la humedad de entrada/salida de cada uno (para volver
--    a secado o pasar a Listo).
--
-- 2. Peso de ingreso inicial: hoy `kg_dried_output` se sobrescribe
--    al cerrar el bache. Si el bache nació en stage 'seco', perdemos
--    el peso original. Agregamos `kg_input_initial` que captura el
--    valor del kg_input_amount al crear el bache, independientemente
--    del stage.
--
-- 3. Factor de conversión: al cerrar el bache calculamos
--    conversion = kg_input_initial / kg_dried_output. Mide cuánto
--    pesa la materia inicial por cada kg de café seco final.
-- ============================================================

-- 1) Histórico de ciclos de descanso
CREATE TABLE IF NOT EXISTS lot_resting_cycles (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_lot_id  uuid NOT NULL REFERENCES production_lots(id) ON DELETE CASCADE,
  cycle_number       int  NOT NULL CHECK (cycle_number >= 1),

  start_date         date NOT NULL,
  start_humidity     numeric(5,2) NOT NULL
    CHECK (start_humidity >= 8 AND start_humidity <= 40),

  -- end_* se llenan cuando el bache sale del descanso (a Drying o a Ready).
  end_date           date,
  end_humidity       numeric(5,2)
    CHECK (end_humidity IS NULL OR (end_humidity >= 8 AND end_humidity <= 40)),
  end_reason         text CHECK (end_reason IS NULL OR end_reason IN ('back_to_drying', 'to_ready')),

  created_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (production_lot_id, cycle_number)
);

CREATE INDEX IF NOT EXISTS idx_lot_resting_cycles_lot ON lot_resting_cycles(production_lot_id);

COMMENT ON TABLE lot_resting_cycles IS
  'Histórico de descansos por bache. Cada vez que entra a Resting se crea una fila. Al salir (a Drying o a Ready) se llenan end_date/end_humidity/end_reason.';

-- 2) Peso inicial al ingresar el bache
ALTER TABLE production_lots
  ADD COLUMN IF NOT EXISTS kg_input_initial numeric(12,2)
    CHECK (kg_input_initial IS NULL OR kg_input_initial > 0);

COMMENT ON COLUMN production_lots.kg_input_initial IS
  'Peso de ingreso al iniciar el bache, en el stage que sea (cereza/despulpado/seco). Inmutable después del create. Se usa para calcular el factor de conversión al cerrar.';

-- Backfill para baches existentes: tomamos el primero que esté no-nulo
-- entre cereza, despulpado y seco. Si después kg_dried_output cambia
-- (cierre del bache), kg_input_initial ya quedó congelado.
UPDATE production_lots
   SET kg_input_initial = COALESCE(kg_cherry_input, kg_despulpado_input, kg_dried_output)
 WHERE kg_input_initial IS NULL;

-- 3) Factor de conversión: kg_input_initial / kg_dried_output (final)
ALTER TABLE production_lots
  ADD COLUMN IF NOT EXISTS conversion_factor numeric(8,4)
    CHECK (conversion_factor IS NULL OR conversion_factor > 0);

COMMENT ON COLUMN production_lots.conversion_factor IS
  'Factor de conversión al cerrar el bache: kg_input_initial / kg_dried_output. Mide cuántos kg de materia inicial se requirieron por cada kg de café seco final.';
