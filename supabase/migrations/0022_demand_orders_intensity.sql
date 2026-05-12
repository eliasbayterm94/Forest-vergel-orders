-- 0022 — Intensity per demand_order
--
-- Forest opcionalmente marca la intensidad del pedido (media / alta /
-- muy_alta). Persiste para que Vergel la vea durante el ciclo de vida.

ALTER TABLE demand_orders
  ADD COLUMN IF NOT EXISTS intensity text
    CHECK (intensity IS NULL OR intensity IN ('media', 'alta', 'muy_alta'));
