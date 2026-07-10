-- =============================================================================
-- Realtime สำหรับ badge ใบลา/คำขอ OT (sidebar ซ้าย + แท็บคำขอ OT + TopBar)
--   1) ให้ตารางอยู่ใน publication supabase_realtime
--   2) REPLICA IDENTITY FULL — จำเป็นเพื่อให้ event UPDATE/DELETE ผ่าน RLS
--      และส่งข้อมูลแถวเดิมครบ (ไม่งั้น realtime อาจไม่ยิง event ตอนอนุมัติ/ปฏิเสธ)
-- IDEMPOTENT: safe to re-run
-- =============================================================================

-- 1. ใส่ตารางเข้า publication (กันกรณียังไม่ได้เพิ่ม)
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE hr_leave_requests;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE hr_ot_requests;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. REPLICA IDENTITY FULL
ALTER TABLE hr_leave_requests REPLICA IDENTITY FULL;
ALTER TABLE hr_ot_requests REPLICA IDENTITY FULL;
