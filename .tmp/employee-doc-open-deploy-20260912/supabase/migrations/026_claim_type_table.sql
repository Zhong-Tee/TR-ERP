-- ตาราง claim_type สำหรับดรอปดาว์น (หัวข้อการเคลม) ลง or_orders.claim_type
CREATE TABLE IF NOT EXISTS claim_type (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE claim_type ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read claim_type"
  ON claim_type FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage claim_type"
  ON claim_type FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin')
    )
  );

-- ข้อมูลเริ่มต้นสำหรับดรอปดาว์น
INSERT INTO claim_type (code, name, sort_order) VALUES
('damage', 'สินค้าเสียหาย', 1),
('missing', 'สินค้าหาย', 2),
('wrong', 'ส่งผิดของ', 3),
('other', 'อื่นๆ', 99)
ON CONFLICT (code) DO NOTHING;
