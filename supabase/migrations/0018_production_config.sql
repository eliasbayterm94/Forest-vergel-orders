-- 0018 — production_config (singleton)
--
-- Tabla de configuracion global de la planta. Patron "single row":
-- el PRIMARY KEY es fijo a 1 via CHECK, asi solo puede existir una
-- fila. Para leer: SELECT * FROM production_config. Para escribir:
-- UPDATE production_config SET ... WHERE id = 1.
--
-- Por ahora solo guarda weekly_cherry_capacity_kg, antes hardcoded
-- en capacity.js como 60000. Mas adelante se le agregan otros
-- parametros globales (timezone, lead-time defaults para futuros
-- procesos, etc).

CREATE TABLE IF NOT EXISTS production_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  weekly_cherry_capacity_kg integer NOT NULL DEFAULT 60000
    CHECK (weekly_cherry_capacity_kg > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- Inserta la fila singleton si no existe.
INSERT INTO production_config (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE production_config ENABLE ROW LEVEL SECURITY;
