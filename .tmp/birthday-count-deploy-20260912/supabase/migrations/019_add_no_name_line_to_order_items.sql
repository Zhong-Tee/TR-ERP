-- Add no_name_line to or_order_items (ไม่รับชื่อ = ไม่รับข้อความบรรทัด 1, 2, 3)
ALTER TABLE or_order_items
  ADD COLUMN IF NOT EXISTS no_name_line BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN or_order_items.no_name_line IS 'เมื่อ true = รายการนี้ไม่รับข้อความบรรทัด 1-3 (แสดงไม่รับชื่อที่หมายเหตุ)';
