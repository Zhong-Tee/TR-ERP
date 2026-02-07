-- ============================================
-- PACKING SCAN TIME + PACKING VIDEOS STORAGE
-- ============================================

-- 1) Add scan timestamp to order items
ALTER TABLE or_order_items
ADD COLUMN IF NOT EXISTS item_scan_time TIMESTAMPTZ;

-- 2) Packing videos metadata table
CREATE TABLE IF NOT EXISTS pk_packing_videos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID REFERENCES or_orders(id) ON DELETE SET NULL,
  work_order_name TEXT,
  tracking_number TEXT,
  storage_path TEXT NOT NULL,
  duration_seconds INTEGER,
  recorded_by TEXT,
  recorded_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE pk_packing_videos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Packing staff can manage packing videos" ON pk_packing_videos;
CREATE POLICY "Packing staff can manage packing videos"
  ON pk_packing_videos FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'packing_staff')
    )
  );

DROP POLICY IF EXISTS "Authenticated users can read packing videos" ON pk_packing_videos;
CREATE POLICY "Authenticated users can read packing videos"
  ON pk_packing_videos FOR SELECT
  USING (auth.role() = 'authenticated');

-- 3) Storage bucket + policies for packing videos
-- NOTE: Supabase Storage buckets are in storage.buckets
INSERT INTO storage.buckets (id, name, public)
VALUES ('packing-videos', 'packing-videos', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Authenticated can read packing-videos" ON storage.objects;
CREATE POLICY "Authenticated can read packing-videos"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'packing-videos');

DROP POLICY IF EXISTS "Authenticated can insert packing-videos" ON storage.objects;
CREATE POLICY "Authenticated can insert packing-videos"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'packing-videos');

DROP POLICY IF EXISTS "Authenticated can update packing-videos" ON storage.objects;
CREATE POLICY "Authenticated can update packing-videos"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'packing-videos') WITH CHECK (bucket_id = 'packing-videos');

DROP POLICY IF EXISTS "Authenticated can delete packing-videos" ON storage.objects;
CREATE POLICY "Authenticated can delete packing-videos"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'packing-videos');
