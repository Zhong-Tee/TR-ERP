-- เพิ่มคอลัมน์ topic ให้ wms_return_requisition_items (แยกหัวข้อต่อรายการ เหมือนใบเบิก)
ALTER TABLE wms_return_requisition_items ADD COLUMN IF NOT EXISTS topic TEXT;
