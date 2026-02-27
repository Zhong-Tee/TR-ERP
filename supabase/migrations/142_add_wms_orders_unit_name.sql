BEGIN;

ALTER TABLE wms_orders
  ADD COLUMN IF NOT EXISTS unit_name TEXT;

UPDATE wms_orders AS w
SET unit_name = COALESCE(NULLIF(TRIM(p.unit_name), ''), 'ชิ้น')
FROM pr_products AS p
WHERE p.product_code = w.product_code
  AND (w.unit_name IS NULL OR TRIM(w.unit_name) = '');

UPDATE wms_orders
SET unit_name = 'ชิ้น'
WHERE unit_name IS NULL OR TRIM(unit_name) = '';

ALTER TABLE wms_orders
  ALTER COLUMN unit_name SET DEFAULT 'ชิ้น';

ALTER TABLE wms_orders
  ALTER COLUMN unit_name SET NOT NULL;

COMMIT;
