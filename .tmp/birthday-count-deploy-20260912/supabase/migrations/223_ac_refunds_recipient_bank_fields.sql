-- ข้อมูลบัญชีรับโอนคืน (กรอกตอนยืนยันโอนเงินเกิน) — แสดงในเมนูบัญชี รายการโอนคืน
ALTER TABLE ac_refunds
  ADD COLUMN IF NOT EXISTS refund_recipient_account_name TEXT,
  ADD COLUMN IF NOT EXISTS refund_recipient_bank TEXT,
  ADD COLUMN IF NOT EXISTS refund_recipient_account_number TEXT;

COMMENT ON COLUMN ac_refunds.refund_recipient_account_name IS 'ชื่อบัญชีผู้รับโอนคืน (กรอกจากออเดอร์)';
COMMENT ON COLUMN ac_refunds.refund_recipient_bank IS 'ธนาคาร';
COMMENT ON COLUMN ac_refunds.refund_recipient_account_number IS 'เลขบัญชี';
