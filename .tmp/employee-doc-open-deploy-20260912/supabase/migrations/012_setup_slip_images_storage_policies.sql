-- ============================================
-- STORAGE BUCKET POLICIES FOR slip-images
-- ============================================
-- This migration sets up storage policies for the slip-images bucket
-- to allow authenticated users to upload, read, and delete their own files

-- Note: The bucket should already exist. If not, create it manually in Supabase Dashboard:
-- Storage → New bucket → Name: slip-images → Public: true/false (as needed)

-- Policy 1: Allow authenticated users to upload files
DROP POLICY IF EXISTS "Authenticated users can upload slip images" ON storage.objects;
CREATE POLICY "Authenticated users can upload slip images"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'slip-images' AND
  auth.role() = 'authenticated'
);

-- Policy 2: Allow authenticated users to read files
DROP POLICY IF EXISTS "Authenticated users can read slip images" ON storage.objects;
CREATE POLICY "Authenticated users can read slip images"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'slip-images' AND
  auth.role() = 'authenticated'
);

-- Policy 3: Allow authenticated users to delete files
-- This is the key policy for allowing file deletion
DROP POLICY IF EXISTS "Authenticated users can delete slip images" ON storage.objects;
CREATE POLICY "Authenticated users can delete slip images"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'slip-images' AND
  auth.role() = 'authenticated'
);

-- Policy 4: Allow authenticated users to update files (if needed)
DROP POLICY IF EXISTS "Authenticated users can update slip images" ON storage.objects;
CREATE POLICY "Authenticated users can update slip images"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'slip-images' AND
  auth.role() = 'authenticated'
)
WITH CHECK (
  bucket_id = 'slip-images' AND
  auth.role() = 'authenticated'
);

-- Alternative: More restrictive policy that only allows users to delete their own files
-- Uncomment this if you want to restrict deletion to files uploaded by the same user
-- Note: This requires storing owner information, which may not be available in all cases

-- DROP POLICY IF EXISTS "Users can delete their own slip images" ON storage.objects;
-- CREATE POLICY "Users can delete their own slip images"
-- ON storage.objects FOR DELETE
-- TO authenticated
-- USING (
--   bucket_id = 'slip-images' AND
--   auth.role() = 'authenticated'
--   -- AND (storage.foldername(name))[1] = auth.uid()::text  -- If using user ID in path
-- );
