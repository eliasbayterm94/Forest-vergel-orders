-- ============================================================
-- 0045_shipment_packaging.sql
--
-- Trazabilidad de empaque por línea de despacho (shipment_lots):
--
--   num_lonas         — # de lonas (los sacos ya existían en
--                       num_sacos; un lote puede ir mixto)
--   empaque_interior  — 'grainpro' | 'bolsa' | NULL. Una sola
--                       opción por línea. La cantidad de bolsas/
--                       grain pro = num_sacos + num_lonas de esa
--                       línea (1 por empaque).
--   color_cinta       — hex (#rrggbb) del color de cinta que se le
--                       pone al lote; la remisión pinta la fila de
--                       ese color para que la trilladora lo
--                       identifique de un vistazo.
--   observaciones     — texto libre por línea, sale en la última
--                       columna de la remisión.
-- ============================================================

ALTER TABLE shipment_lots
  ADD COLUMN IF NOT EXISTS num_lonas integer
    CHECK (num_lonas IS NULL OR num_lonas >= 0),
  ADD COLUMN IF NOT EXISTS empaque_interior text
    CHECK (empaque_interior IS NULL OR empaque_interior IN ('grainpro', 'bolsa')),
  ADD COLUMN IF NOT EXISTS color_cinta text
    CHECK (color_cinta IS NULL OR color_cinta ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN IF NOT EXISTS observaciones text;

COMMENT ON COLUMN shipment_lots.num_lonas IS
  '# de lonas despachadas en esta línea (num_sacos ya existía; mixto permitido).';
COMMENT ON COLUMN shipment_lots.empaque_interior IS
  'Empaque interior de los bultos: grainpro | bolsa | NULL. Cantidad = num_sacos + num_lonas.';
COMMENT ON COLUMN shipment_lots.color_cinta IS
  'Color hex de la cinta del lote; pinta la fila en la remisión.';
COMMENT ON COLUMN shipment_lots.observaciones IS
  'Observaciones libres por línea; última columna de la remisión.';
