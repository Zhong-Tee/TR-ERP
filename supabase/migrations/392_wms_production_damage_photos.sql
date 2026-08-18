BEGIN;

ALTER TABLE public.wms_requisition_items
  ADD COLUMN IF NOT EXISTS damage_image_paths text[] NOT NULL DEFAULT '{}'::text[];

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('wms-damage-evidence', 'wms-damage-evidence', false, 10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "WMS production damage photos read" ON storage.objects;
CREATE POLICY "WMS production damage photos read" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'wms-damage-evidence');

DROP POLICY IF EXISTS "WMS production damage photos insert" ON storage.objects;
CREATE POLICY "WMS production damage photos insert" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'wms-damage-evidence' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "WMS production damage photos delete own" ON storage.objects;
CREATE POLICY "WMS production damage photos delete own" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'wms-damage-evidence' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE OR REPLACE FUNCTION public.validate_wms_production_damage_photos()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.requisition_topic IN ('ผลิตเสีย', 'สินค้าชำรุด')
     AND (NULLIF(btrim(NEW.item_note), '') IS NULL OR cardinality(NEW.damage_image_paths) < 1) THEN
    RAISE EXCEPTION 'Damage requisition requires a note and at least one photo';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_wms_production_damage_photos ON public.wms_requisition_items;
CREATE TRIGGER trg_validate_wms_production_damage_photos BEFORE INSERT OR UPDATE
ON public.wms_requisition_items FOR EACH ROW EXECUTE FUNCTION public.validate_wms_production_damage_photos();

COMMIT;
