-- เหตุผลโอนคืน (กรอกตอนยืนยันโอนเงินเกิน ในหน้าบัญชีรับโอนคืน)
-- แสดงในเมนูบัญชี → รายการโอนคืน ใต้บรรทัด (ยอดบิล:xx, สลิป:xx)
ALTER TABLE ac_refunds
  ADD COLUMN IF NOT EXISTS refund_recipient_reason TEXT;

COMMENT ON COLUMN ac_refunds.refund_recipient_reason IS 'เหตุผลโอนคืน (กรอกจากออเดอร์ตอนยืนยันโอนเกิน) — แสดงในรายการโอนคืน';
