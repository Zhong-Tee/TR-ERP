-- Roll back migration 390 after removing the "เบิกชำรุด" feature.
-- The private Storage bucket is intentionally retained because Supabase does
-- not allow a non-empty bucket to be removed safely from a SQL migration.

BEGIN;

DROP TRIGGER IF EXISTS trg_validate_damaged_requisition_evidence
  ON public.wms_requisition_items;

DROP FUNCTION IF EXISTS public.validate_damaged_requisition_evidence();

DROP POLICY IF EXISTS "WMS damage evidence read" ON storage.objects;
DROP POLICY IF EXISTS "WMS damage evidence insert" ON storage.objects;
DROP POLICY IF EXISTS "WMS damage evidence delete own" ON storage.objects;

ALTER TABLE public.wms_requisitions
  DROP CONSTRAINT IF EXISTS wms_requisitions_request_type_check;

ALTER TABLE public.wms_requisition_items
  DROP COLUMN IF EXISTS damage_note,
  DROP COLUMN IF EXISTS damage_image_paths;

ALTER TABLE public.wms_requisitions
  DROP COLUMN IF EXISTS request_type;

COMMIT;
