-- 0013 — despacho a nivel parcial
--
-- Antes: shipment_lots era una pivot (shipment_id, production_lot_id) y un
-- lote solo podia estar en un despacho (UNIQUE production_lot_id).
--
-- Ahora un despacho puede contener parciales individuales del lote (cuando
-- el lote tiene parciales registrados). El esquema soporta dos modos:
--
--   • Modo lote completo  → lot_partial_id IS NULL (legacy, lotes sin
--                            parciales). Maximo una fila por lote.
--   • Modo parciales      → lot_partial_id apunta al parcial. Cada parcial
--                            puede estar en a lo sumo un despacho.
--
-- Adicionalmente lot_partials gana rejected_at / rejection_reason para
-- marcar parciales que la finca decide no despachar (no cumplen calidad).

-- 1) lot_partials: rechazo
ALTER TABLE lot_partials
  ADD COLUMN IF NOT EXISTS rejected_at      timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

-- 2) shipment_lots: id sintetico + lot_partial_id
ALTER TABLE shipment_lots
  ADD COLUMN IF NOT EXISTS id uuid;

UPDATE shipment_lots SET id = gen_random_uuid() WHERE id IS NULL;

ALTER TABLE shipment_lots
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- Quitar viejos PK / UNIQUE (puede que vengan de migraciones previas o de
-- esta misma corrida). Usamos IF EXISTS para que sea idempotente.
ALTER TABLE shipment_lots DROP CONSTRAINT IF EXISTS shipment_lots_pkey;
ALTER TABLE shipment_lots DROP CONSTRAINT IF EXISTS shipment_lots_production_lot_id_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shipment_lots_id_pkey'
  ) THEN
    ALTER TABLE shipment_lots ADD CONSTRAINT shipment_lots_id_pkey PRIMARY KEY (id);
  END IF;
END $$;

ALTER TABLE shipment_lots
  ADD COLUMN IF NOT EXISTS lot_partial_id uuid
    REFERENCES lot_partials(id) ON DELETE RESTRICT;

-- Indexes parciales: ningun lote completo se despacha dos veces; ningun
-- parcial se despacha dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS shipment_lots_whole_lot_unique
  ON shipment_lots (production_lot_id) WHERE lot_partial_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS shipment_lots_partial_unique
  ON shipment_lots (lot_partial_id) WHERE lot_partial_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shipment_lots_partial
  ON shipment_lots (lot_partial_id);
