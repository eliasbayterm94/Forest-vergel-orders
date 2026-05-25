-- ============================================================
-- 0029_sub_batches.sql
--
-- Sub-baches (lotes hijos) durante el proceso de beneficio.
--
-- Cuando un bache es muy grande y necesita separarse durante el
-- secado (o cualquier etapa), se crea un "sub-bache" que es un
-- production_lot completo con parent_lot_id apuntando al padre.
--
-- Nomenclatura: P1, P2, P3... (reemplaza las letras A, B, C de
-- lot_partials para flujos nuevos). El bache_code del hijo se
-- autogenera como "{bache_padre}-P{n}".
--
-- Cada sub-bache tiene su propio ciclo de vida independiente:
-- puede avanzar de Drying → Resting → Ready → Delivered a su
-- propio ritmo, con sus propios kg, factor, ciclos de reposo, etc.
--
-- El padre conserva el kg restante y sigue procesándose con
-- normalidad. Si queda en 0 kg por sucesivas divisiones, se
-- queda como contenedor informativo.
--
-- lot_partials sigue existiendo para backwards compat (los
-- parciales con letras creados antes de este cambio).
-- ============================================================

ALTER TABLE production_lots
  ADD COLUMN IF NOT EXISTS parent_lot_id uuid REFERENCES production_lots(id),
  ADD COLUMN IF NOT EXISTS sub_bache_number integer;

CREATE INDEX IF NOT EXISTS idx_production_lots_parent
  ON production_lots(parent_lot_id) WHERE parent_lot_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_production_lots_sub_bache
  ON production_lots(parent_lot_id, sub_bache_number) WHERE parent_lot_id IS NOT NULL;

COMMENT ON COLUMN production_lots.parent_lot_id IS
  'Lote padre del que se dividió este sub-bache. NULL si es un lote raíz.';
COMMENT ON COLUMN production_lots.sub_bache_number IS
  'Número secuencial del sub-bache (1 → P1, 2 → P2, ...).';
