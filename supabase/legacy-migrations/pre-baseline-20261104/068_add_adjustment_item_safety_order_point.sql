-- เพิ่มคอลัมน์ new_safety_stock และ new_order_point ใน inv_adjustment_items
-- เพื่อเก็บค่าที่ต้องการเปลี่ยน รออนุมัติก่อนจึงจะอัปเดตจริง
ALTER TABLE inv_adjustment_items ADD COLUMN IF NOT EXISTS new_safety_stock NUMERIC(12, 2);
ALTER TABLE inv_adjustment_items ADD COLUMN IF NOT EXISTS new_order_point TEXT;
