-- 0016 — processing_days en process_lead_times
--
-- Antes la fecha maxima de inicio de drying se calculaba como
--   delivery - drying_days
-- Ahora se le suman dias de procesamiento previos (fermentacion +
-- despulpado + secado al sol antes de entrar al cuarto, etc) que
-- viven en la nueva columna processing_days. Default 6 dias para los
-- tres procesos; el operador puede ajustarlo via SQL si cambia el
-- workflow.

ALTER TABLE process_lead_times
  ADD COLUMN IF NOT EXISTS processing_days integer NOT NULL DEFAULT 6
    CHECK (processing_days >= 0);

-- Por si la fila existe con default null en alguna migracion intermedia
UPDATE process_lead_times SET processing_days = 6 WHERE processing_days IS NULL;
