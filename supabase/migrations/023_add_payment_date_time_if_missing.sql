-- เพิ่ม payment_date, payment_time ใน or_orders ถ้ายังไม่มี (กรณี schema ไม่ตรงกับ 001)
ALTER TABLE or_orders
  ADD COLUMN IF NOT EXISTS payment_date DATE,
  ADD COLUMN IF NOT EXISTS payment_time TIME;

COMMENT ON COLUMN or_orders.payment_date IS 'วันที่ชำระเงิน';
COMMENT ON COLUMN or_orders.payment_time IS 'เวลาชำระเงิน';
