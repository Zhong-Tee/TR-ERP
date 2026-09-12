CREATE TABLE IF NOT EXISTS pr_sellers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- เปิด RLS
ALTER TABLE pr_sellers ENABLE ROW LEVEL SECURITY;

-- ผู้ใช้ที่ login แล้วอ่านได้ทุกคน
CREATE POLICY "pr_sellers read"
  ON pr_sellers FOR SELECT
  USING (auth.role() = 'authenticated');

-- เฉพาะ superadmin, admin-tr เพิ่ม/แก้ไข/ลบ
CREATE POLICY "pr_sellers write"
  ON pr_sellers FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr')
    )
  );

CREATE POLICY "pr_sellers update"
  ON pr_sellers FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr')
    )
  );

CREATE POLICY "pr_sellers delete"
  ON pr_sellers FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr')
    )
  );

-- seed ข้อมูลผู้ขายจากสินค้าที่มีอยู่ (ถ้ามี)
INSERT INTO pr_sellers (name)
SELECT DISTINCT seller_name
FROM pr_products
WHERE seller_name IS NOT NULL AND seller_name <> ''
ON CONFLICT (name) DO NOTHING;
