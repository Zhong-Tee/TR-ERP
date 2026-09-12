-- ============================================
-- QC CHECKLIST: หัวข้อเช็คลิสตรวจ QC
-- ============================================

-- 1. หัวข้อใหญ่
CREATE TABLE IF NOT EXISTS qc_checklist_topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE qc_checklist_topics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view checklist topics"
  ON qc_checklist_topics FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admin and QC staff can manage checklist topics"
  ON qc_checklist_topics FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'admin-tr', 'admin_qc', 'qc_staff')
    )
  );

-- 2. หัวข้อย่อย (ภายใต้หัวข้อใหญ่)
CREATE TABLE IF NOT EXISTS qc_checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id UUID NOT NULL REFERENCES qc_checklist_topics(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  file_url TEXT,
  file_type TEXT CHECK (file_type IS NULL OR file_type IN ('image', 'pdf')),
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_qc_checklist_items_topic ON qc_checklist_items(topic_id);

ALTER TABLE qc_checklist_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view checklist items"
  ON qc_checklist_items FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admin and QC staff can manage checklist items"
  ON qc_checklist_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'admin-tr', 'admin_qc', 'qc_staff')
    )
  );

-- 3. เชื่อมหัวข้อกับสินค้า
CREATE TABLE IF NOT EXISTS qc_checklist_topic_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id UUID NOT NULL REFERENCES qc_checklist_topics(id) ON DELETE CASCADE,
  product_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(topic_id, product_code)
);

CREATE INDEX idx_qc_checklist_topic_products_topic ON qc_checklist_topic_products(topic_id);
CREATE INDEX idx_qc_checklist_topic_products_code ON qc_checklist_topic_products(product_code);

ALTER TABLE qc_checklist_topic_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view checklist topic products"
  ON qc_checklist_topic_products FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admin and QC staff can manage checklist topic products"
  ON qc_checklist_topic_products FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'admin-tr', 'admin_qc', 'qc_staff')
    )
  );

-- 4. Storage bucket สำหรับไฟล์เช็คลิส (รูปภาพ/PDF)
INSERT INTO storage.buckets (id, name, public)
VALUES ('qc-checklist-files', 'qc-checklist-files', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Anyone can view checklist files"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'qc-checklist-files');

CREATE POLICY "Authenticated can upload checklist files"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'qc-checklist-files'
    AND auth.role() = 'authenticated'
  );

CREATE POLICY "Authenticated can delete checklist files"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'qc-checklist-files'
    AND auth.role() = 'authenticated'
  );
