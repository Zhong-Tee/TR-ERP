-- =============================================================================
-- Migration 324: สรุปการรับทราบประกาศ (คอลัมน์ "รับทราบ" + badge เมนูประกาศ)
--   1) get_announcement_ack_summary()      → จำนวนคนรับทราบ/เป้าหมาย ของทุกประกาศ
--   2) get_announcement_attention_count()  → เลข badge เมนู "ประกาศ"
--        = ประกาศที่รออนุมัติ + ประกาศที่เผยแพร่แล้วแต่พนักงานรับทราบไม่ครบ
--   3) เปิด realtime ให้ hr_announcement_reads เพื่อให้ตัวเลขเด้งทันทีที่มีคนกดรับทราบ
--
-- หมายเหตุ: ทั้งสองฟังก์ชันเป็นตัวเลขสำหรับแสดงผล — ผู้ที่ไม่มีสิทธิ์จัดการประกาศ
--   จะได้ผลลัพธ์ว่าง/0 แทนการ RAISE เพื่อไม่ให้หน้าจอพัง (ต่างจาก
--   get_announcement_ack_status ที่คืนรายชื่อพนักงานจึงยัง RAISE เหมือนเดิม)
--
-- นับ "เป้าหมาย" ด้วยเกณฑ์เดียวกับ get_announcement_ack_status:
--   พนักงานสถานะ active/probation ที่อยู่ในแผนกเป้าหมายของประกาศ
-- IDEMPOTENT: safe to re-run
-- =============================================================================

DROP FUNCTION IF EXISTS get_announcement_ack_summary();
CREATE FUNCTION get_announcement_ack_summary()
RETURNS TABLE (
  announcement_id UUID,
  target_count INT,
  acked_count INT
) AS $$
  SELECT
    a.id,
    count(e.id)::INT,
    count(r.id)::INT
  FROM hr_announcements a
  LEFT JOIN hr_employees e
    ON e.employment_status IN ('active','probation')
   AND (
     a.target_all_departments
     OR EXISTS (
       SELECT 1 FROM hr_announcement_departments ad
       WHERE ad.announcement_id = a.id AND ad.department_id = e.department_id
     )
   )
  LEFT JOIN hr_announcement_reads r
    ON r.announcement_id = a.id AND r.employee_id = e.id
  WHERE hr_can_manage_announcements()
  GROUP BY a.id;
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public;

REVOKE ALL ON FUNCTION get_announcement_ack_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_announcement_ack_summary() TO authenticated;

DROP FUNCTION IF EXISTS get_announcement_attention_count();
CREATE FUNCTION get_announcement_attention_count() RETURNS INT AS $$
  SELECT CASE WHEN NOT hr_can_manage_announcements() THEN 0 ELSE (
    SELECT count(*)::INT
    FROM hr_announcements a
    WHERE a.status = 'pending'
       OR (
         a.status = 'published'
         AND EXISTS (
           SELECT 1 FROM hr_employees e
           WHERE e.employment_status IN ('active','probation')
             AND (
               a.target_all_departments
               OR EXISTS (
                 SELECT 1 FROM hr_announcement_departments ad
                 WHERE ad.announcement_id = a.id AND ad.department_id = e.department_id
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM hr_announcement_reads r
               WHERE r.announcement_id = a.id AND r.employee_id = e.id
             )
         )
       )
  ) END;
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public;

REVOKE ALL ON FUNCTION get_announcement_attention_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_announcement_attention_count() TO authenticated;

-- Realtime: badge/คอลัมน์รับทราบอัปเดตทันทีที่พนักงานกดรับทราบ
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE hr_announcement_reads;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

NOTIFY pgrst, 'reload schema';
