-- =====================================================================
-- Migration 322: ทำเครื่องหมาย "ส่งสลิปแล้ว" ให้รายการโอนคืน
--   - บัญชี (หน้ารายการอนุมัติ) กดปุ่ม "ส่งสลิปแล้ว" หลังส่งสลิปให้ลูกค้าแล้ว
--   - ฝั่งออเดอร์ (แท็บโอนคืน) รายการจะย้ายจาก "อนุมัติแล้ว" ไป "เสร็จสิ้น" อัตโนมัติ
--
-- หมายเหตุสำคัญ: ไม่แตะคอลัมน์ status เพราะ status = 'approved' ถูกใช้ในงบทดลอง
--   (fn คำนวณยอดคืนใน migration 163) และตัวนับ badge — เพิ่มคอลัมน์ใหม่แทน
--   เพื่อไม่ให้ตัวเลขทางบัญชีเปลี่ยน
-- =====================================================================

ALTER TABLE ac_refunds
  ADD COLUMN IF NOT EXISTS refund_slip_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refund_slip_sent_by UUID REFERENCES us_users(id);

COMMENT ON COLUMN ac_refunds.refund_slip_sent_at IS 'เวลาที่บัญชีกดยืนยันว่าส่งสลิปโอนคืนให้ลูกค้าแล้ว (NULL = ยังไม่ส่ง)';
COMMENT ON COLUMN ac_refunds.refund_slip_sent_by IS 'ผู้กดยืนยันว่าส่งสลิปโอนคืนแล้ว';

-- ค้นรายการที่ยังไม่ได้ส่งสลิปได้เร็วขึ้น (แท็บ "อนุมัติแล้ว" ฝั่งออเดอร์)
CREATE INDEX IF NOT EXISTS idx_ac_refunds_slip_sent_at
  ON ac_refunds (refund_slip_sent_at)
  WHERE refund_slip_sent_at IS NULL;

-- สิทธิ์ update ใช้ policy เดิม "Account staff can manage refunds" (superadmin/admin-tr/account)
-- Sales อ่านได้จาก migration 276 — ไม่ต้องเพิ่ม RLS ใหม่

NOTIFY pgrst, 'reload schema';
