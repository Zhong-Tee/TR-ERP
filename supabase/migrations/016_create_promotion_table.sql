-- ============================================
-- PROMOTION TABLE (promotion)
-- ใช้เป็นรายการตัวเลือกโปรโมชั่นในฟอร์มสร้าง/แก้ไขออเดอร์
-- ============================================
CREATE TABLE IF NOT EXISTS promotion (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE promotion ENABLE ROW LEVEL SECURITY;

-- RLS: ผู้ใช้ที่ล็อกอินแล้วอ่านได้, แอดมิน/order_staff จัดการได้
CREATE POLICY "Anyone authenticated can view active promotions"
  ON promotion FOR SELECT
  USING (auth.role() = 'authenticated' AND (is_active = true OR auth.uid() IS NOT NULL));

CREATE POLICY "Admins and order staff can manage promotions"
  ON promotion FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff')
    )
  );

CREATE INDEX IF NOT EXISTS idx_promotion_is_active ON promotion(is_active);

CREATE TRIGGER update_promotion_updated_at
  BEFORE UPDATE ON promotion
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ข้อมูลตัวอย่าง (ลบหรือแก้ได้ตามต้องการ)
INSERT INTO promotion (name, is_active)
SELECT * FROM (VALUES
  ('ไม่มีโปรโมชั่น', true),
  ('ส่งฟรี', true),
  ('ส่วนลด 10%', true)
) AS v(name, is_active)
WHERE NOT EXISTS (SELECT 1 FROM promotion LIMIT 1);
