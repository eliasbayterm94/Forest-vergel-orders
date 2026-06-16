-- ============================================================
-- 0041_drop_assignment_compat_checks.sql
--
-- Producción quiere poder asignar cualquier bache a cualquier
-- pedido activo. Antes el trigger enforce_lot_order_assignment_compat
-- bloqueaba:
--
--   1) reference_id distinto entre lote y pedido
--   2) process_type distinto entre lote y pedido
--   3) (relajado en 0019) over-allocation contra kg_green_accepted
--
-- Removemos el trigger por completo. El ÚNICO control que queda
-- es el de inventario por lote (enforce_lot_total_allocation,
-- trigger trg_loa_lot_capacity) que impide asignar más kg verde
-- de los que el bache realmente produjo — eso sí no debe poderse
-- sobre-asignar.
-- ============================================================

DROP TRIGGER IF EXISTS trg_loa_compat ON lot_order_assignments;
DROP FUNCTION IF EXISTS enforce_lot_order_assignment_compat();
