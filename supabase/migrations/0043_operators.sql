-- ============================================================
-- 0043_operators.sql
--
-- Tabla administrable de OPERARIOS. El login del sistema es una
-- contraseña compartida por rol (forest/finca/admin), así que el
-- audit trail solo registra el rol. Esta tabla habilita
-- accountability individual sin rehacer el auth:
--
--   · El admin registra los operarios en /admin/config
--   · Cada usuario elige "quién es" en el sidebar (persistido en
--     localStorage del dispositivo)
--   · El API client anexa operator_name a cada POST y los
--     endpoints de auditoría lo incluyen en los tags de notes:
--       [Ajuste seco · finca (Juan P.) · 2026-06-21] ...
--
-- Mismo patrón que fermentation_tanks (sin kind).
-- ============================================================

CREATE TABLE IF NOT EXISTS operators (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        citext NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_operators_updated_at ON operators;
CREATE TRIGGER trg_operators_updated_at
BEFORE UPDATE ON operators
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE operators ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE operators IS
  'Operarios registrables para accountability individual en auditorías. El login sigue siendo por rol; el operario activo se elige en el sidebar y viaja como operator_name en los requests.';
