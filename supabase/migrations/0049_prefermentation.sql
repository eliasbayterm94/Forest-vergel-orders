-- ============================================================
-- 0049_prefermentation.sql
--
-- 1) PREFERMENTACIÓN: horas que el café se deja prefermentando
--    ANTES de que arranque la fermentación inicial.
--
--    Vive en dos tablas, igual que fermentation_hours:
--      · coffee_references  → la receta (auto-rellena el formulario)
--      · production_lots    → lo que realmente se hizo en el bache
--
--    Nullable a propósito:
--      NULL = no se registró
--      0    = no hubo prefermentación
--    Esa distinción importa para calidad de dato en analíticas.
--
--    Solo guarda el número PLANIFICADO. No hay timestamp de inicio,
--    así que no se calcula "real vs. plan" como en fermentación
--    (que sí tiene fermentation_start_at / drying_start_at).
--
--    No entra en cálculos de capacidad ni lead-times — igual que
--    fermentation_hours hoy. Es un parámetro descriptivo del perfil.
--
-- 2) Tipo de fermentación "Secado directo".
--
--    El sistema ya modela "sin fermentación" con
--    fermentation_hours = 0 (el bache nace en Drying, ver
--    production-lots-create.js). Este tipo es el ROTULO explícito
--    de esa condición, para que salga en la hoja de vida del bache.
--
--    Para que no existan baches contradictorios, la API mantiene el
--    invariante  "Secado directo" ∈ fermentation_types  ⟺  horas = 0:
--      · pedir el tipo con horas != 0 → 400
--      · poner horas = 0              → el tipo se marca solo
--    Ver _lib/fermentationTypes.js (reconcileSecadoDirecto).
--
-- 3) Tanque "Pilón": es un RECIPIENTE, no un método, así que va en
--    fermentation_tanks. `kind` queda NULL — clasificalo desde
--    /admin/config si querés agruparlo (Madera, Acero…).
-- ============================================================

-- 1) Prefermentación
ALTER TABLE coffee_references
  ADD COLUMN IF NOT EXISTS prefermentation_hours numeric(6,2);

ALTER TABLE production_lots
  ADD COLUMN IF NOT EXISTS prefermentation_hours numeric(6,2);

DO $$
BEGIN
  ALTER TABLE coffee_references
    ADD CONSTRAINT coffee_references_prefermentation_hours_check
    CHECK (prefermentation_hours IS NULL OR prefermentation_hours >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE production_lots
    ADD CONSTRAINT production_lots_prefermentation_hours_check
    CHECK (prefermentation_hours IS NULL OR prefermentation_hours >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN coffee_references.prefermentation_hours IS
  'Horas de prefermentación de la receta (antes de la fermentación inicial). Auto-rellena el formulario del bache. NULL = sin registrar, 0 = no hubo.';
COMMENT ON COLUMN production_lots.prefermentation_hours IS
  'Horas de prefermentación aplicadas al bache, antes de la fermentación inicial. Solo planificado: no hay timestamp, así que no se calcula real vs. plan. NULL = sin registrar, 0 = no hubo.';

-- 2) Tipo "Secado directo"
INSERT INTO fermentation_types (name) VALUES
  ('Secado directo')
ON CONFLICT (name) DO NOTHING;

-- 3) Tanque "Pilón"
INSERT INTO fermentation_tanks (name) VALUES
  ('Pilón')
ON CONFLICT (name) DO NOTHING;
