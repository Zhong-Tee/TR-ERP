-- เพิ่มคอลัมน์ is_free สำหรับสินค้าของแถม (ฟรี) ในรายการสั่งซื้อ
ALTER TABLE or_order_items
ADD COLUMN IF NOT EXISTS is_free boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN or_order_items.is_free IS 'สินค้าของแถม (ฟรี) — ราคา 0 บาท ไม่นับยอด';
