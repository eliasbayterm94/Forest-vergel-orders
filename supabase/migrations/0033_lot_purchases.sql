-- ============================================================
-- 0033_lot_purchases.sql
--
-- Compras en finca: cuando un cliente llega a la finca y compra o
-- aparta café directamente de bodega (Punto Final). Es una vía
-- ligera, separada del pipeline de pedidos formales (demand_orders):
-- solo requiere el nombre del cliente y los kg VERDE comprados.
--
-- Total o parcial: se puede asignar parte del lote a una compra y
-- dejar el resto disponible. Las compras se descuentan del verde
-- disponible del lote (junto con asignaciones a pedidos, despachos
-- y mezclas) — ver cálculo "neto real" en el front/endpoint.
--
-- Las asignaciones a pedidos FV existentes siguen usando
-- lot_order_assignments (vía "Ambas" en la UI de Punto Final).
-- ============================================================

CREATE TABLE IF NOT EXISTS lot_purchases (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_lot_id   uuid NOT NULL REFERENCES production_lots(id) ON DELETE CASCADE,
  client_name         text NOT NULL CHECK (length(trim(client_name)) > 0),
  kg_green_allocated  numeric(12,2) NOT NULL CHECK (kg_green_allocated > 0),
  notes               text,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_lot_purchases_lot ON lot_purchases(production_lot_id);

ALTER TABLE lot_purchases ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE lot_purchases IS
  'Compras/reservas hechas en finca: cliente + kg verde tomados de un lote en bodega. Vía ligera, independiente de demand_orders.';
COMMENT ON COLUMN lot_purchases.kg_green_allocated IS
  'kg VERDE asignados a esta compra (las compras siempre se asignan en verde).';
