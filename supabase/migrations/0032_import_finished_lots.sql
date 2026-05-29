-- ============================================================
-- 0032_import_finished_lots.sql
--
-- Carga histórica de 35 baches que ya están terminados (Listo) en
-- la bodega de Punto Final. Se insertan DIRECTO en status='Ready'
-- (el trigger de transición de estados solo aplica en UPDATE, no en
-- INSERT, así que esto es válido).
--
-- También agrega la columna final_humidity para conservar la humedad
-- final registrada en la Matriz/Galapp.
--
-- Idempotente: re-ejecutar no duplica (WHERE NOT EXISTS por bache_code
-- y ON CONFLICT DO NOTHING en variedades).
--
-- ─────────────────────────────────────────────────────────────
-- DECISIONES TOMADAS (revisar si algo cambia):
--   · factor_rendimiento = "Factor Real en la Matriz" en todos.
--   · Proceso: 26-194, 26-226, 26-231, 26-234, 26-242 quedan como
--     LAVADO (cambiaron de Honey en Galapp a Lavado en la Matriz).
--   · Humedad: se usa la de la Matriz; donde falta (26-221, 26-228,
--     26-240, 26-247, 26-252, 26-254) se usa la de Galapp.
--   · kg_green_actual se calcula: round((seco / factor) * 70).
--   · processing_stage = 'cereza'; kg_cherry_input y kg_input_initial
--     = kilos de cereza de entrada.
--
-- ⚠ A REVISAR (datos sospechosos, cargados tal cual):
--   · 26-214: cereza 151 → seco 88 (rendimiento 58%, anómalo vs
--     lotes similares ~25%). Posible error de digitación.
--   · 26-247: factor Galapp 101 vs Matriz 126.5 (gran diferencia;
--     se usó 126.5). Verde cambia ~39 kg según cuál se use.
--   · Variedades con acentos: si la BD ya tiene 'Típica'/'Etíope'
--     con tilde, este script crea 'Tipica'/'Etiope' sin tilde como
--     nuevas. Revisar y unificar si es el caso.
-- ============================================================

ALTER TABLE production_lots
  ADD COLUMN IF NOT EXISTS final_humidity numeric(5,2)
    CHECK (final_humidity IS NULL OR (final_humidity >= 0 AND final_humidity <= 100));

COMMENT ON COLUMN production_lots.final_humidity IS
  'Humedad final registrada en la Matriz/Galapp al cierre del bache (%).';

-- Variedades referenciadas (idempotente)
INSERT INTO coffee_varieties (name) VALUES
  ('Borbon Rosado'), ('Robusta'), ('Papayo'), ('Wush Wush'), ('Moka'),
  ('Java'), ('Yirgachef'), ('Maragesha'), ('Guava'), ('Geisha'),
  ('Sidra'), ('Tipica'), ('Obata'), ('Etiope')
ON CONFLICT (name) DO NOTHING;

-- Lotes + enlace de variedad
WITH src(bache_code, process_type, variety, cereza, seco, factor, humidity, start_date, ready_date) AS (
  VALUES
    ('26-152','Lavado','Borbon Rosado',  486, 105,  92.1, 11.50, DATE '2026-03-26', DATE '2026-04-04'),
    ('26-155','Natural','Robusta',        133,  40, 139.1, 10.80, DATE '2026-03-26', DATE '2026-04-16'),
    ('26-156','Natural','Papayo',         806, 235, 122.1, 10.40, DATE '2026-03-26', DATE '2026-05-04'),
    ('26-162','Natural','Wush Wush',      725, 181, 121.4, 10.10, DATE '2026-03-28', DATE '2026-04-16'),
    ('26-167','Honey','Borbon Rosado',    554, 116,  93.3, 11.20, DATE '2026-04-01', DATE '2026-04-13'),
    ('26-179','Natural','Moka',           384, 113, 118.6, 10.50, DATE '2026-04-08', DATE '2026-04-29'),
    ('26-180','Natural','Java',          1273, 355, 118.0, 10.40, DATE '2026-04-08', DATE '2026-04-28'),
    ('26-194','Lavado','Borbon Rosado',   713, 163,  95.5, 10.20, DATE '2026-04-11', DATE '2026-04-25'),
    ('26-196','Natural','Yirgachef',       64,  17, 126.5, 11.80, DATE '2026-04-11', DATE '2026-05-08'),
    ('26-203','Natural','Wush Wush',      453, 145, 123.5, 11.30, DATE '2026-04-16', DATE '2026-05-11'),
    ('26-209','Natural','Maragesha',      151,  40, 137.3, 11.00, DATE '2026-04-18', DATE '2026-05-05'),
    ('26-214','Natural','Guava',          151,  88, 137.3, 11.40, DATE '2026-04-23', DATE '2026-05-08'),
    ('26-216','Honey','Geisha',           546, 100,  93.3, 10.50, DATE '2026-04-23', DATE '2026-05-15'),
    ('26-217','Natural','Guava',          655, 179, 117.3, 10.90, DATE '2026-04-24', DATE '2026-05-07'),
    ('26-219','Honey','Geisha',           128,  28,  91.7, 11.20, DATE '2026-04-23', DATE '2026-05-07'),
    ('26-221','Natural','Yirgachef',      113,  48, 122.8,  9.50, DATE '2026-04-24', DATE '2026-05-23'),
    ('26-223','Natural','Sidra',          110,  38, 122.8, 11.00, DATE '2026-04-25', DATE '2026-05-11'),
    ('26-224','Natural','Guava',          196,  58, 141.9, 11.30, DATE '2026-04-25', DATE '2026-05-09'),
    ('26-225','Natural','Java',            37,  12, 138.2, 10.90, DATE '2026-04-25', DATE '2026-05-11'),
    ('26-226','Lavado','Geisha',          337,  64,  95.5, 11.40, DATE '2026-04-25', DATE '2026-05-09'),
    ('26-227','Natural','Tipica',         210,  28, 128.0, 11.10, DATE '2026-04-27', DATE '2026-05-15'),
    ('26-228','Natural','Robusta',        407, 112, 124.3,  9.80, DATE '2026-04-29', DATE '2026-05-23'),
    ('26-229','Natural','Tipica',         689, 231, 124.3, 11.30, DATE '2026-04-29', DATE '2026-05-15'),
    ('26-230','Honey','Geisha',           479,  23,  95.5, 11.30, DATE '2026-04-29', DATE '2026-05-19'),
    ('26-231','Lavado','Borbon Rosado',   209,  19, 102.4, 11.80, DATE '2026-04-29', DATE '2026-05-12'),
    ('26-233','Natural','Guava',          428, 125, 119.3, 11.80, DATE '2026-04-29', DATE '2026-05-18'),
    ('26-234','Lavado','Papayo',          149,  50,  94.2, 11.50, DATE '2026-04-29', DATE '2026-05-19'),
    ('26-235','Natural','Moka',           861, 251, 128.8, 11.10, DATE '2026-04-29', DATE '2026-05-20'),
    ('26-236','Natural','Wush Wush',     1886, 202, 119.3, 11.30, DATE '2026-04-30', DATE '2026-05-12'),
    ('26-238','Honey','Papayo',          1867, 380,  96.3, 10.50, DATE '2026-05-02', DATE '2026-05-14'),
    ('26-240','Natural','Obata',          124,  35, 133.8, 10.20, DATE '2026-05-01', DATE '2026-05-20'),
    ('26-242','Lavado','Borbon Rosado',   168,  34,  95.9, 10.30, DATE '2026-05-02', DATE '2026-05-19'),
    ('26-247','Honey','Papayo',          1310, 277, 126.5, 11.30, DATE '2026-05-06', DATE '2026-05-26'),
    ('26-252','Natural','Sidra',          580, 177, 126.5,  9.80, DATE '2026-05-08', DATE '2026-05-21'),
    ('26-254','Natural','Etiope',         636, 198, 137.3,  9.80, DATE '2026-05-08', DATE '2026-05-22')
),
ins AS (
  INSERT INTO production_lots (
    bache_code, process_type, processing_stage,
    kg_cherry_input, kg_input_initial, kg_green_expected,
    kg_dried_output, factor_rendimiento, kg_green_actual,
    conversion_factor, final_humidity,
    status, start_date, ready_date, created_by, notes
  )
  SELECT
    s.bache_code, s.process_type, 'cereza',
    s.cereza, s.cereza, round(s.cereza::numeric / 7.65, 2),
    s.seco, s.factor, round((s.seco::numeric / s.factor) * 70),
    round(s.cereza::numeric / s.seco, 4), s.humidity,
    'Ready', s.start_date, s.ready_date, 'import-historico',
    'Carga histórica — bodega Punto Final'
  FROM src s
  WHERE NOT EXISTS (
    SELECT 1 FROM production_lots p WHERE p.bache_code = s.bache_code
  )
  RETURNING id, bache_code
)
INSERT INTO production_lot_varieties (production_lot_id, variety_id)
SELECT ins.id, cv.id
FROM ins
JOIN src s ON s.bache_code = ins.bache_code
JOIN coffee_varieties cv ON cv.name = s.variety
ON CONFLICT DO NOTHING;
