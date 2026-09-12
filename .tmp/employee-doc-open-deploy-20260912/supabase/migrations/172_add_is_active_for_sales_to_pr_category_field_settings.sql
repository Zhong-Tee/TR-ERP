-- เปิด/ปิดหมวดหมู่สำหรับการขาย (แสดงในตั้งค่าสินค้า + รายการเลือกสินค้าตอนเปิดบิล)
ALTER TABLE pr_category_field_settings
  ADD COLUMN IF NOT EXISTS is_active_for_sales BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN pr_category_field_settings.is_active_for_sales IS 'เมื่อ false หมวดนี้ไม่แสดงในตั้งค่าฟิลด์/override และไม่ให้เลือกสินค้าในหมวดนี้ตอนเปิดบิล';
