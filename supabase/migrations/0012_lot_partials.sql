-- 0012 — lot_partials
--
-- Un bache puede secarse en parciales (A, B, C, ... hasta F). Cada parcial
-- tiene su propio peso seco y factor de rendimiento, asi que el verde
-- equivalente se calcula por parcial: (kg_dried / factor) * 70.
--
-- Mientras el lote esta en Drying la finca registra parciales conforme
-- los va sacando del secadero. Al "Cerrar bache" (Drying → Ready) la
-- aplicacion suma los rendimientos de todos los parciales para llenar
-- production_lots.kg_green_actual.

CREATE TABLE IF NOT EXISTS lot_partials (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_lot_id   uuid NOT NULL REFERENCES production_lots(id) ON DELETE CASCADE,
  parcial_letter      text NOT NULL CHECK (parcial_letter IN ('A','B','C','D','E','F')),

  kg_dried            numeric(12,2) NOT NULL CHECK (kg_dried > 0),
  factor_rendimiento  numeric(8,4)  NOT NULL CHECK (factor_rendimiento > 0),

  -- (kg_dried / factor) * 70  →  kg verde equivalente del parcial
  kg_green_yield      numeric(12,2) GENERATED ALWAYS AS
                        (round((kg_dried / factor_rendimiento) * 70, 2)) STORED,

  completed_at        timestamptz NOT NULL DEFAULT now(),
  notes               text,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (production_lot_id, parcial_letter)
);

CREATE INDEX IF NOT EXISTS idx_lot_partials_lot
  ON lot_partials(production_lot_id);

ALTER TABLE lot_partials ENABLE ROW LEVEL SECURITY;
