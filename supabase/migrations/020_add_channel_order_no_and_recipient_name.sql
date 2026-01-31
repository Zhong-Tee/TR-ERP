-- เลขคำสั่งซื้อ (แสดงเมื่อช่องทาง SPTR, FSPTR, TTTR, LZTR, PGTR, WY)
-- ชื่อลูกค้า ใต้ที่อยู่ (recipient_name สำหรับช่องทาง FBTR, PUMP, OATR, SHOP, INFU, PN)
ALTER TABLE or_orders
  ADD COLUMN IF NOT EXISTS channel_order_no TEXT,
  ADD COLUMN IF NOT EXISTS recipient_name TEXT;

COMMENT ON COLUMN or_orders.channel_order_no IS 'เลขคำสั่งซื้อ (ช่องทาง SPTR, FSPTR, TTTR, LZTR, PGTR, WY)';
COMMENT ON COLUMN or_orders.recipient_name IS 'ชื่อลูกค้า ใต้ที่อยู่ (ช่องทาง FBTR, PUMP, OATR, SHOP, INFU, PN)';
