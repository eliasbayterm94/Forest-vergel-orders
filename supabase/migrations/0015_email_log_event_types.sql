-- 0015 — relax email_log.event_type CHECK
--
-- 0004 limito event_type a 4 valores. Despues agregamos
-- 'demand_created' (notify a finca cuando entra pedido) y a futuro
-- queremos poder agregar mas eventos sin migracion. El check pasa a
-- ser una lista mas larga + dejamos abierto a extension.

ALTER TABLE email_log DROP CONSTRAINT IF EXISTS email_log_event_type_check;
ALTER TABLE email_log
  ADD CONSTRAINT email_log_event_type_check
  CHECK (event_type IN (
    'demand_created',
    'demand_accepted',
    'demand_rejected',
    'order_completed',
    'weekly_digest'
  ));
