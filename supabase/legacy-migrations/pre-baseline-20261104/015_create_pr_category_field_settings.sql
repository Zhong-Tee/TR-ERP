-- ตั้งค่าฟิลด์ที่อนุญาตให้กรอกได้ต่อหมวดหมู่สินค้า (pr_products.product_category)
CREATE TABLE IF NOT EXISTS pr_category_field_settings (
  category TEXT PRIMARY KEY,
  product_name BOOLEAN DEFAULT true,
  ink_color BOOLEAN DEFAULT true,
  layer BOOLEAN DEFAULT true,
  cartoon_pattern BOOLEAN DEFAULT true,
  line_pattern BOOLEAN DEFAULT true,
  font BOOLEAN DEFAULT true,
  line_1 BOOLEAN DEFAULT true,
  line_2 BOOLEAN DEFAULT true,
  line_3 BOOLEAN DEFAULT true,
  quantity BOOLEAN DEFAULT true,
  unit_price BOOLEAN DEFAULT true,
  notes BOOLEAN DEFAULT true,
  attachment BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE pr_category_field_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view category field settings"
  ON pr_category_field_settings FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage category field settings"
  ON pr_category_field_settings FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'admin_qc')
    )
  );

COMMENT ON TABLE pr_category_field_settings IS 'กำหนดว่าหมวดหมู่สินค้าไหนอนุญาตให้กรอกฟิลด์ใดได้บ้าง ในฟอร์มสร้าง/แก้ไขออเดอร์';
