-- ============================================================
-- 0047_shipment_draft.sql
--
-- Despachos en estado BORRADOR (preparación de bodega).
--
-- Un despacho puede nacer como 'draft': se guarda con los baches y
-- kg que ya se conocen (la logística —destino, conductor, códigos,
-- empaque— puede quedar vacía) y sirve como orden de preparación
-- para bodega. Mientras está en borrador:
--   · los baches NO se marcan Delivered
--   · los pedidos NO se completan
--   · pero los kg SÍ se apartan del inventario disponible (bucket
--     "en preparación"): las líneas de un borrador cuentan como
--     retenidas, no como despachadas, hasta confirmarlo.
--
-- Al confirmar (status → 'confirmed') se corre la cascada normal de
-- entrega: baches Delivered + pedidos completados. La clasificación
-- inventario (retenido vs despachado) es puramente por este status,
-- así una misma fila shipment_lots pasa de "en preparación" a
-- "despachado" sin reescribirse.
--
-- Los despachos existentes quedan 'confirmed' por defecto.
-- ============================================================

ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('draft', 'confirmed')),
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

COMMENT ON COLUMN shipments.status IS
  'draft = borrador de preparación (aparta inventario, no despacha); confirmed = despacho definitivo (baches Delivered, pedidos completados).';
COMMENT ON COLUMN shipments.confirmed_at IS
  'Momento en que el borrador se confirmó como despacho definitivo. NULL en borradores.';

CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
