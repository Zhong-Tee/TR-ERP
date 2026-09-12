-- =============================================================================
-- 180: รูปเครื่องจักร + Storage bucket machinery-photos
-- =============================================================================

BEGIN;

ALTER TABLE pr_machinery_machines
  ADD COLUMN IF NOT EXISTS image_url TEXT;

COMMENT ON COLUMN pr_machinery_machines.image_url IS 'Public URL รูปเครื่อง (Supabase Storage)';

INSERT INTO storage.buckets (id, name, public)
VALUES ('machinery-photos', 'machinery-photos', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "machinery_photos_select" ON storage.objects;
CREATE POLICY "machinery_photos_select"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'machinery-photos');

DROP POLICY IF EXISTS "machinery_photos_insert" ON storage.objects;
CREATE POLICY "machinery_photos_insert"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'machinery-photos');

DROP POLICY IF EXISTS "machinery_photos_update" ON storage.objects;
CREATE POLICY "machinery_photos_update"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'machinery-photos') WITH CHECK (bucket_id = 'machinery-photos');

DROP POLICY IF EXISTS "machinery_photos_delete" ON storage.objects;
CREATE POLICY "machinery_photos_delete"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'machinery-photos');

COMMIT;
