-- Marketplace: บันทึกเวลาที่ sales กด "บันทึกร่าง" ในงาน (แสดงป้าย + ใช้กรองในแถบ Assign)
BEGIN;

ALTER TABLE mp_orders
  ADD COLUMN IF NOT EXISTS draft_saved_at TIMESTAMPTZ;

COMMENT ON COLUMN mp_orders.draft_saved_at IS
  'เวลาที่บันทึกร่างล่าสุด (NULL = ยังไม่เคยบันทึกร่าง) — ใช้แสดงป้าย "บันทึกร่าง" ในแถบ Assign (294)';

COMMIT;
