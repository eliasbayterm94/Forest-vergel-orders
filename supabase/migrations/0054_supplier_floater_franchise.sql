-- ---------------------------------------------------------------------
-- 0054 — Floater franchise per supplier
--
-- A negotiated term: the buyer absorbs floaters up to a threshold and
-- only discounts what exceeds it. The real delivery that prompted this:
-- 9.8% floated, the discount applied "from 5% up", so 4.8% was
-- discounted and the first 5 points were absorbed.
--
-- Recording it per supplier lets the reception screen suggest the
-- discount instead of someone doing the subtraction in their head, and
-- — more useful — name what the franchise costs:
--
--   shortfall = floater_rate − discount = min(floater_rate, franchise)
--   cost      = kg_gross × price × shortfall
--
-- That is 986,517 COP on the delivery above. It is not an accident of
-- a bad lot: whenever floaters exceed the franchise, the franchise
-- costs exactly its own percentage of the delivery's gross value.
--
-- Nothing here enters the cost calculation. The franchise is a
-- negotiation aid; the cost of a reception is still, and only, what was
-- actually paid over the net kg.
--
-- NULL = no franchise agreed (same as 0). Additive and nullable, so
-- existing suppliers are untouched.
-- ---------------------------------------------------------------------

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS floater_franchise_pct numeric(6,4);

DO $$
BEGIN
  ALTER TABLE suppliers
    ADD CONSTRAINT chk_supplier_floater_franchise
    CHECK (floater_franchise_pct IS NULL
           OR (floater_franchise_pct >= 0 AND floater_franchise_pct <= 1));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN suppliers.floater_franchise_pct IS
  'Franquicia de flotes negociada, como fracción (0.05 = se descuenta solo lo que pase del 5%). NULL o 0 = sin franquicia, el descuento sugerido iguala el % de flotes. Solo sirve para sugerir el descuento y medir lo que cuesta; no entra al costeo.';
