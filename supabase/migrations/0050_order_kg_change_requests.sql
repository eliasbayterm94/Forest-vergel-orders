-- ============================================================
-- 0050_order_kg_change_requests.sql
--
-- AJUSTE DE CANTIDAD DE UN PEDIDO, con aprobación de la finca.
--
-- El problema que resuelve
-- ------------------------
-- Forest podía editar kg_green_required desde el formulario de
-- edición, pero eso no servía para nada:
--
--   · El objetivo de producción es kg_green_accepted, no
--     kg_green_required (ver _lib/orderCompletion.js).
--   · El inbox de la finca lista solo pedidos Pending, así que un
--     pedido ya aceptado nunca volvía a aparecer para revisión.
--   · Y en pedidos Accepted la constraint chk_status_consistency
--     (migración 0002) exige kg_green_accepted = kg_green_required,
--     así que el UPDATE fallaba con un "Update failed" opaco.
--
-- Resultado: subir los kg "parecía" guardar y producción nunca se
-- enteraba.
--
-- El modelo
-- ---------
-- Cambiar la cantidad de un pedido ya aceptado NO es editar un dato:
-- es renegociar el compromiso. La finca tiene que confirmar que puede
-- producirlo. Entonces el ajuste viaja como una SOLICITUD:
--
--   1. Forest pide un delta (+200 o -150) → se guarda acá sin tocar
--      kg_green_required ni kg_green_accepted.
--   2. La finca lo ve y acepta o rechaza.
--   3. Al aceptar, required y accepted suben (o bajan) JUNTOS, en un
--      solo update, así chk_status_consistency nunca se rompe.
--   4. Al rechazar, se limpia la solicitud y nada cambia.
--
-- Pedidos Pending son la excepción: nadie aceptó todavía
-- (kg_green_accepted IS NULL) y el pedido sigue en el inbox de la
-- finca, así que ahí el cambio se aplica directo sin solicitud.
--
-- Por qué no se reusó PartiallyAccepted
-- -------------------------------------
-- Ese estado ya significa "la finca rechazó parte y Forest la compra
-- afuera" — demand-orders-list deriva kg_green_external_needed de la
-- diferencia required - accepted. Si un delta pendiente viviera en esa
-- diferencia, esos kg aparecerían como compra externa. Además la
-- transición Accepted → PartiallyAccepted está prohibida por
-- enforce_demand_order_status_transition.
-- ============================================================

ALTER TABLE demand_orders
  ADD COLUMN IF NOT EXISTS kg_green_pending_delta     numeric(12,2),
  ADD COLUMN IF NOT EXISTS pending_delta_reason       text,
  ADD COLUMN IF NOT EXISTS pending_delta_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS pending_delta_requested_by text;

-- Un delta de 0 no es una solicitud. NULL = sin solicitud pendiente.
DO $$
BEGIN
  ALTER TABLE demand_orders
    ADD CONSTRAINT chk_pending_delta_not_zero
    CHECK (kg_green_pending_delta IS NULL OR kg_green_pending_delta <> 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Para el badge del chrome y los filtros de la cola.
CREATE INDEX IF NOT EXISTS idx_demand_orders_pending_delta
  ON demand_orders (kg_green_pending_delta)
  WHERE kg_green_pending_delta IS NOT NULL;

COMMENT ON COLUMN demand_orders.kg_green_pending_delta IS
  'Ajuste de kg verde solicitado por Forest y pendiente de que la finca lo acepte. Positivo = añadir, negativo = quitar. NULL = sin solicitud. Al aceptarse, kg_green_required y kg_green_accepted se mueven juntos por este monto y la columna se limpia.';
COMMENT ON COLUMN demand_orders.pending_delta_reason IS
  'Motivo que escribió Forest al pedir el ajuste. Queda como rastro de la negociación.';
COMMENT ON COLUMN demand_orders.pending_delta_requested_at IS
  'Cuándo se pidió el ajuste. Sirve para ordenar la cola de solicitudes por antigüedad.';
COMMENT ON COLUMN demand_orders.pending_delta_requested_by IS
  'Usuario que pidió el ajuste (username de la sesión).';
