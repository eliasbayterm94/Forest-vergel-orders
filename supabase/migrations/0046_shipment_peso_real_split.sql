-- ============================================================
-- 0046_shipment_peso_real_split.sql
--
-- Dos capacidades nuevas en despachos:
--
-- 1) Peso real de báscula en despachos totales.
--    Al despachar TODO un bache, el peso que marca la báscula puede
--    diferir unos kg del registrado en Punto Final (gana o pierde
--    humedad en el proceso). La remisión debe llevar el peso real,
--    pero el bache debe cerrar igual sin dejar saldo fantasma.
--
--    kg_dried_merma — diferencia entre lo registrado en bodega y el
--    peso real despachado en esta línea:
--      > 0  merma    (báscula por debajo del registro)
--      < 0  ganancia (báscula por encima)
--    Para el inventario la merma cuenta como kg que SALIERON de
--    bodega (junto al despacho), así el disponible queda en 0.
--
-- 2) División de un bache en líneas P1 / P2 / … al despachar.
--    Mismo No. de bache con un identificador por línea; cada línea
--    lleva su propio kg, empaque, color y observaciones, y puede
--    salir en la misma remisión o en despachos distintos (la
--    numeración continúa automáticamente).
--
--    split_label — 'P1', 'P2', … NULL para líneas sin división.
-- ============================================================

ALTER TABLE shipment_lots
  ADD COLUMN IF NOT EXISTS kg_dried_merma numeric,
  ADD COLUMN IF NOT EXISTS split_label text
    CHECK (split_label IS NULL OR split_label ~ '^P[0-9]+$');

COMMENT ON COLUMN shipment_lots.kg_dried_merma IS
  'Diferencia bodega − báscula en despacho total: >0 merma, <0 ganancia de humedad. Cuenta como kg salidos de bodega.';
COMMENT ON COLUMN shipment_lots.split_label IS
  'Identificador de división del bache en el despacho (P1, P2, …). NULL si la línea no es una división.';
