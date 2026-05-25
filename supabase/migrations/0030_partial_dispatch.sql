-- ============================================================
-- 0030_partial_dispatch.sql
--
-- Despacho parcial por kg: permite despachar una parte del kg
-- seco de un bache Ready. El restante queda en bodega (status
-- Ready). El bache pasa a Delivered solo cuando todo su kg seco
-- ha sido despachado.
--
-- Cambios:
--   · shipment_lots.kg_dried_shipped: kg seco efectivamente
--     despachado en esta línea. Para despachos completos = todo
--     el kg_dried_output del lote. Para parciales = lo indicado.
--   · Se elimina la restricción UNIQUE que impedía que el mismo
--     lote apareciera en múltiples despachos sin partial_id
--     (necesario para despachos parciales sucesivos).
-- ============================================================

ALTER TABLE shipment_lots
  ADD COLUMN IF NOT EXISTS kg_dried_shipped numeric(12,2);

DROP INDEX IF EXISTS shipment_lots_whole_lot_unique;

COMMENT ON COLUMN shipment_lots.kg_dried_shipped IS
  'kg de seco despachado en esta línea. NULL = despacho completo (todo el lote).';
