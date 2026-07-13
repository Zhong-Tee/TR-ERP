-- เพิ่มเหตุผลไม่อนุมัติการโอนคืน — กรอกจาก popup ยืนยันปฏิเสธ ในเมนูบัญชี รายการโอนคืน
ALTER TABLE ac_refunds
  ADD COLUMN IF NOT EXISTS rejected_reason TEXT;

COMMENT ON COLUMN ac_refunds.rejected_reason IS 'เหตุผลไม่อนุมัติการโอนคืน (กรอกตอนกดปฏิเสธ)';
