-- =============================================================================
-- เหตุผลที่ไม่อนุมัติ ตรวจสลิปมือ (ac_manual_slip_checks.rejected_reason)
--   - บัญชีกรอกเหตุผลตอนไม่อนุมัติ/ปฏิเสธ → แสดงที่เมนูออเดอร์ (ตรวจสอบไม่ผ่าน)
-- IDEMPOTENT: รันซ้ำได้
-- =============================================================================

ALTER TABLE ac_manual_slip_checks
  ADD COLUMN IF NOT EXISTS rejected_reason TEXT;

NOTIFY pgrst, 'reload schema';
