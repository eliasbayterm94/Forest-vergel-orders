-- =====================================================================
-- Forest Production Bridge — 0004_email_log
-- Audit trail for all outbound notifications.
-- =====================================================================

CREATE TABLE email_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      text NOT NULL CHECK (event_type IN
                    ('demand_accepted','demand_rejected','order_completed','weekly_digest')),
  to_address      text NOT NULL,
  subject         text NOT NULL,
  body            text NOT NULL,
  related_order_id uuid REFERENCES demand_orders(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed','dry_run')),
  error_message   text,
  sent_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_log_event_type     ON email_log(event_type);
CREATE INDEX idx_email_log_sent_at        ON email_log(sent_at DESC);
CREATE INDEX idx_email_log_related_order  ON email_log(related_order_id);
