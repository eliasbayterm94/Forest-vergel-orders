-- 0017 — agregar daily_new_orders al CHECK de email_log.event_type
--
-- En 0015 relajamos el check para aceptar demand_created. Ahora el
-- demand_created inmediato se reemplaza por un digest diario que
-- recopila los pedidos nuevos en las ultimas 24h. Necesita el nuevo
-- event_type 'daily_new_orders'. Conservamos 'demand_created' para
-- evitar romper inserts existentes.

ALTER TABLE email_log DROP CONSTRAINT IF EXISTS email_log_event_type_check;
ALTER TABLE email_log
  ADD CONSTRAINT email_log_event_type_check
  CHECK (event_type IN (
    'demand_created',
    'daily_new_orders',
    'demand_accepted',
    'demand_rejected',
    'order_completed',
    'weekly_digest'
  ));
