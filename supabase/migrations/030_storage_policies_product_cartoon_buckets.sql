-- ============================================
-- STORAGE BUCKET POLICIES FOR product-images และ cartoon-patterns
-- ============================================
-- Bucket ต้องมีอยู่แล้ว (สร้างใน Supabase Dashboard > Storage ถ้ายังไม่มี)
-- ชื่อ bucket: product-images, cartoon-patterns

-- ---------- product-images ----------
DROP POLICY IF EXISTS "Authenticated can read product-images" ON storage.objects;
CREATE POLICY "Authenticated can read product-images"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'product-images');

DROP POLICY IF EXISTS "Authenticated can insert product-images" ON storage.objects;
CREATE POLICY "Authenticated can insert product-images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'product-images');

DROP POLICY IF EXISTS "Authenticated can update product-images" ON storage.objects;
CREATE POLICY "Authenticated can update product-images"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'product-images') WITH CHECK (bucket_id = 'product-images');

DROP POLICY IF EXISTS "Authenticated can delete product-images" ON storage.objects;
CREATE POLICY "Authenticated can delete product-images"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'product-images');

-- ---------- cartoon-patterns ----------
DROP POLICY IF EXISTS "Authenticated can read cartoon-patterns" ON storage.objects;
CREATE POLICY "Authenticated can read cartoon-patterns"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'cartoon-patterns');

DROP POLICY IF EXISTS "Authenticated can insert cartoon-patterns" ON storage.objects;
CREATE POLICY "Authenticated can insert cartoon-patterns"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'cartoon-patterns');

DROP POLICY IF EXISTS "Authenticated can update cartoon-patterns" ON storage.objects;
CREATE POLICY "Authenticated can update cartoon-patterns"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'cartoon-patterns') WITH CHECK (bucket_id = 'cartoon-patterns');

DROP POLICY IF EXISTS "Authenticated can delete cartoon-patterns" ON storage.objects;
CREATE POLICY "Authenticated can delete cartoon-patterns"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'cartoon-patterns');
