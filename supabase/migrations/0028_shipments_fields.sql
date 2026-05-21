-- ============================================================
-- 0028_shipments_fields.sql
--
-- Campos nuevos en despachos para operación con trilladora y
-- transporte:
--
-- shipments:
--   destino_kind     'Vertical' | 'Tribox' | 'Trillanova' | 'Otro'
--   destino_other    texto libre cuando destino_kind = 'Otro'
--   driver_cedula    cédula del conductor
--   driver_placas    placa del vehículo
--   driver_name      nombre del conductor
--
-- shipment_lots:
--   codigo_trilladora  identificador de trilladora por bache (manual,
--                      formato sugerido PP-XXXX pero libre)
--   codigo_mezcla      código de mezcla externo de la trilladora
--                      (numérico/texto manual; distinto del blend_code
--                      interno MZ-YYYY-NNNN que se autogenera al
--                      mezclar baches en Punto Final)
--   num_sacos          cantidad de lonas que componen ese bache en el
--                      despacho. Se totaliza en el PDF.
--   partials_merged    cuando un bache tiene varios parciales en este
--                      despacho, true (default) los muestra agrupados
--                      en el PDF; false los lista por separado.
-- ============================================================

ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS destino_kind text
    CHECK (destino_kind IS NULL OR destino_kind IN ('Vertical', 'Tribox', 'Trillanova', 'Otro')),
  ADD COLUMN IF NOT EXISTS destino_other text,
  ADD COLUMN IF NOT EXISTS driver_cedula text,
  ADD COLUMN IF NOT EXISTS driver_placas text,
  ADD COLUMN IF NOT EXISTS driver_name text;

ALTER TABLE shipment_lots
  ADD COLUMN IF NOT EXISTS codigo_trilladora text,
  ADD COLUMN IF NOT EXISTS codigo_mezcla text,
  ADD COLUMN IF NOT EXISTS num_sacos integer CHECK (num_sacos IS NULL OR num_sacos >= 0),
  ADD COLUMN IF NOT EXISTS partials_merged boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN shipments.destino_kind IS
  'Destino del despacho: Vertical, Tribox, Trillanova u Otro (texto libre en destino_other).';
COMMENT ON COLUMN shipment_lots.codigo_trilladora IS
  'Código manual de trilladora (sugerido PP-XXXX) por bache despachado.';
COMMENT ON COLUMN shipment_lots.codigo_mezcla IS
  'Código de mezcla externo de la trilladora. Distinto del blend_code interno MZ-YYYY-NNNN que se autogenera al mezclar baches en Punto Final.';
COMMENT ON COLUMN shipment_lots.partials_merged IS
  'true = todos los parciales del mismo bache se agrupan en una sola línea en el PDF; false = se listan separados.';
