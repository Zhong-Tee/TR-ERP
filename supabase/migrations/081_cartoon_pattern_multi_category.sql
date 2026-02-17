-- ลายการ์ตูนรองรับหลายหมวดหมู่: เปลี่ยน product_category TEXT → product_categories TEXT[]
ALTER TABLE cp_cartoon_patterns
  ADD COLUMN IF NOT EXISTS product_categories TEXT[];

-- ย้ายข้อมูลเดิมไปคอลัมน์ใหม่
UPDATE cp_cartoon_patterns
  SET product_categories = ARRAY[product_category]
  WHERE product_category IS NOT NULL
    AND product_category <> ''
    AND product_categories IS NULL;

-- ลบคอลัมน์เดิม
ALTER TABLE cp_cartoon_patterns DROP COLUMN IF EXISTS product_category;
