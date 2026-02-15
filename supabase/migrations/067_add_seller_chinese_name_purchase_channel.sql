-- เพิ่มคอลัมน์ ชื่อผู้ขายภาษาจีน และ ช่องทางซื้อ ในตาราง pr_sellers
ALTER TABLE pr_sellers ADD COLUMN IF NOT EXISTS name_cn TEXT DEFAULT '';
ALTER TABLE pr_sellers ADD COLUMN IF NOT EXISTS purchase_channel TEXT DEFAULT '';
