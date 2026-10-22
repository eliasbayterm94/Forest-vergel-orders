-- ---------------------------------------------------------------------
-- 0053 — Weighing detail and quality readings on a cherry reception
--
-- What the farm emails after every delivery, which the reception could
-- not hold: the scale reading, the sack count, the tare those sacks
-- account for, and the lab numbers.
--
-- The important one is the weighing chain, because "net" meant two
-- different things:
--
--   kg_scale_gross                      5092.00   what the scale read
--   − sacks_count × tare_per_sack_kg  −   32.90   94 sacks × 0.35
--   = kg_gross                          5059.10   actual coffee  <-- paid on this
--   − byproduct (floaters)            −  495.78
--   = cost-bearing net                  4563.32   what carries the cost
--
-- kg_gross keeps its meaning — the weight of coffee, the base the
-- payment is computed on — so amount_paid_cop and every pool and
-- snapshot built on it stay exactly as they were. The new columns are
-- the audit trail of how that number was reached, plus a check that
-- the arithmetic holds.
--
-- All additive and nullable: existing receptions keep their kg_gross
-- and simply have no weighing detail recorded.
-- ---------------------------------------------------------------------

ALTER TABLE cherry_receptions
  ADD COLUMN IF NOT EXISTS kg_scale_gross         numeric(12,2),
  ADD COLUMN IF NOT EXISTS sacks_count            integer,
  ADD COLUMN IF NOT EXISTS tare_per_sack_kg       numeric(6,3),
  ADD COLUMN IF NOT EXISTS cherry_to_pulped_ratio numeric(5,4),
  ADD COLUMN IF NOT EXISTS brix_pct               numeric(5,2),
  ADD COLUMN IF NOT EXISTS ph                     numeric(4,2);

-- Plain range guards. Each one tolerates NULL: none of this is required.
DO $$
BEGIN
  ALTER TABLE cherry_receptions
    ADD CONSTRAINT chk_reception_scale_gross
    CHECK (kg_scale_gross IS NULL OR kg_scale_gross > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE cherry_receptions
    ADD CONSTRAINT chk_reception_sacks_count
    CHECK (sacks_count IS NULL OR sacks_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The tare rate is stored per reception, not read from a setting, so a
-- later change to the standard sack weight cannot silently rewrite the
-- arithmetic of a delivery already recorded.
DO $$
BEGIN
  ALTER TABLE cherry_receptions
    ADD CONSTRAINT chk_reception_tare_per_sack
    CHECK (tare_per_sack_kg IS NULL OR (tare_per_sack_kg >= 0 AND tare_per_sack_kg <= 5));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Cherry → pulped conversion, as a fraction (0.544 = 54.4%).
DO $$
BEGIN
  ALTER TABLE cherry_receptions
    ADD CONSTRAINT chk_reception_cherry_to_pulped
    CHECK (cherry_to_pulped_ratio IS NULL
           OR (cherry_to_pulped_ratio > 0 AND cherry_to_pulped_ratio <= 1));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE cherry_receptions
    ADD CONSTRAINT chk_reception_brix
    CHECK (brix_pct IS NULL OR (brix_pct >= 0 AND brix_pct <= 100));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE cherry_receptions
    ADD CONSTRAINT chk_reception_ph
    CHECK (ph IS NULL OR (ph >= 0 AND ph <= 14));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The weighing chain must add up. Only enforced when the detail was
-- actually recorded, so old rows and quick entries are unaffected.
-- One cent of tolerance, since kg_gross is rounded to 2 decimals.
DO $$
BEGIN
  ALTER TABLE cherry_receptions
    ADD CONSTRAINT chk_reception_weighing_adds_up
    CHECK (
      kg_scale_gross IS NULL
      OR sacks_count IS NULL
      OR tare_per_sack_kg IS NULL
      OR abs(kg_gross - (kg_scale_gross - sacks_count * tare_per_sack_kg)) <= 0.01
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN cherry_receptions.kg_scale_gross IS
  'Peso bruto en balanza, lonas incluidas. Solo trazabilidad: el pago se calcula sobre kg_gross.';
COMMENT ON COLUMN cherry_receptions.sacks_count IS
  'Número de lonas de la entrega. Con tare_per_sack_kg explica la diferencia entre kg_scale_gross y kg_gross.';
COMMENT ON COLUMN cherry_receptions.tare_per_sack_kg IS
  'Peso de una lona vacía usado en ESTA recepción (típico 0.350). Se guarda por recepción para que cambiar el estándar no reescriba entregas pasadas.';
COMMENT ON COLUMN cherry_receptions.cherry_to_pulped_ratio IS
  'Conversión de cereza a despulpado medida en la entrega, como fracción (0.544 = 54.4%). Dato de calidad, no entra al costeo.';
COMMENT ON COLUMN cherry_receptions.brix_pct IS 'Grados Brix medidos en la entrega.';
COMMENT ON COLUMN cherry_receptions.ph IS 'pH medido en la entrega.';

COMMENT ON COLUMN cherry_receptions.kg_gross IS
  'Kg de CAFÉ: peso en balanza menos la tara de las lonas. Es la base del pago (amount_paid_cop = kg_gross × precio × (1 − descuento)). Los flotes se restan aparte, en lot_byproducts, para obtener el neto que carga el costo.';
COMMENT ON COLUMN cherry_receptions.discount_pct IS
  'Descuento negociado, como fracción. Se paga ese % menos sobre los kg de café. Equilibra el costo cuando iguala el % de flotes.';
