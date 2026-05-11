-- 0020 — kg_green_yield redondeado a entero (half-up)
--
-- Antes la columna generada era numeric(12,2) con round(..., 2). Los
-- valores proyectados son operacionales (entran al PDF, a la cola,
-- a los reportes) y los decimales no aportan utilidad. El usuario
-- pide enteros con regla "≥0.50 sube, <0.50 baja", que coincide con
-- la convencion de PostgreSQL para round() en numeros positivos.
--
-- PostgreSQL no permite ALTER COLUMN en columnas generated; hay que
-- DROP + ADD. No hay perdida de datos porque la columna se recalcula
-- automaticamente desde kg_dried y factor_rendimiento.

ALTER TABLE lot_partials DROP COLUMN IF EXISTS kg_green_yield;
ALTER TABLE lot_partials
  ADD COLUMN kg_green_yield numeric(12,0)
  GENERATED ALWAYS AS (round((kg_dried / factor_rendimiento) * 70)) STORED;
