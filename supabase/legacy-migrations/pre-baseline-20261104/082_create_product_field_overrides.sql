-- ตั้งค่าฟิลด์ override ระดับสินค้า (null = ใช้ค่าจากหมวดหมู่, true = เปิด, false = ปิด)
CREATE TABLE IF NOT EXISTS pr_product_field_overrides (
  product_id UUID PRIMARY KEY REFERENCES pr_products(id) ON DELETE CASCADE,
  ink_color       BOOLEAN,
  layer           BOOLEAN,
  cartoon_pattern BOOLEAN,
  line_pattern    BOOLEAN,
  font            BOOLEAN,
  line_1          BOOLEAN,
  line_2          BOOLEAN,
  line_3          BOOLEAN,
  quantity        BOOLEAN,
  unit_price      BOOLEAN,
  notes           BOOLEAN,
  attachment      BOOLEAN,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE pr_product_field_overrides IS 'Override ตั้งค่าฟิลด์ระดับสินค้า — null = ใช้ค่าจาก pr_category_field_settings, true/false = override';

ALTER TABLE pr_product_field_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view product field overrides"
  ON pr_product_field_overrides FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage product field overrides"
  ON pr_product_field_overrides FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'admin_qc')
    )
  );
