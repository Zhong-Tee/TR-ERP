-- ============================================
-- Storage bucket + policies for sample images
-- ============================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('sample-images', 'sample-images', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Authenticated can read sample-images" ON storage.objects;
CREATE POLICY "Authenticated can read sample-images"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'sample-images');

DROP POLICY IF EXISTS "Authenticated can insert sample-images" ON storage.objects;
CREATE POLICY "Authenticated can insert sample-images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'sample-images');

DROP POLICY IF EXISTS "Authenticated can update sample-images" ON storage.objects;
CREATE POLICY "Authenticated can update sample-images"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'sample-images') WITH CHECK (bucket_id = 'sample-images');

DROP POLICY IF EXISTS "Authenticated can delete sample-images" ON storage.objects;
CREATE POLICY "Authenticated can delete sample-images"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'sample-images');
