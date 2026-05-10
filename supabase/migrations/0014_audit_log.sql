-- 0014 — audit_log
--
-- Captura INSERT/UPDATE/DELETE de las entidades core (demand_orders,
-- production_lots, lot_partials, lot_order_assignments, shipments,
-- shipment_lots) con before/after en JSONB. El actor se extrae con
-- best-effort desde la columna created_by si existe (algunas tablas
-- la traen, otras no — `to_jsonb(NEW) ->> 'created_by'` devuelve
-- NULL silenciosamente cuando la columna no existe).
--
-- En una iteracion futura podemos plomar el actor real via
-- set_config('app.actor', ..., true) en cada endpoint y leerlo aqui
-- con current_setting('app.actor', true).

CREATE TABLE IF NOT EXISTS audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  action      text NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  actor       text,
  before_json jsonb,
  after_json  jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_at     ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION fn_audit_capture()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_actor  text;
  v_id     text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_after := to_jsonb(NEW);
    v_id    := COALESCE(v_after ->> 'id', '');
    v_actor := COALESCE(
      v_after ->> 'created_by',
      current_setting('app.actor', true)
    );
  ELSIF TG_OP = 'UPDATE' THEN
    v_before := to_jsonb(OLD);
    v_after  := to_jsonb(NEW);
    -- saltar si no cambio nada
    IF v_before = v_after THEN
      RETURN NULL;
    END IF;
    v_id    := COALESCE(v_after ->> 'id', v_before ->> 'id', '');
    v_actor := COALESCE(
      current_setting('app.actor', true),
      v_after  ->> 'created_by',
      v_before ->> 'created_by'
    );
  ELSE  -- DELETE
    v_before := to_jsonb(OLD);
    v_id     := COALESCE(v_before ->> 'id', '');
    v_actor  := COALESCE(
      current_setting('app.actor', true),
      v_before ->> 'created_by'
    );
  END IF;

  INSERT INTO audit_log(entity_type, entity_id, action, actor, before_json, after_json)
  VALUES (TG_TABLE_NAME, v_id, TG_OP, NULLIF(v_actor, ''), v_before, v_after);

  RETURN NULL;  -- AFTER trigger
END;
$$;

-- Aplicar triggers a las tablas core. Borramos primero por si la
-- migracion se re-corre.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'demand_orders', 'production_lots', 'lot_partials',
    'lot_order_assignments', 'shipments', 'shipment_lots'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%1$s ON %1$s', t);
    EXECUTE format(
      'CREATE TRIGGER trg_audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$s
         FOR EACH ROW EXECUTE FUNCTION fn_audit_capture()', t);
  END LOOP;
END $$;
