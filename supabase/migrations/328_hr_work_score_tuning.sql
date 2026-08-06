-- =============================================================================
-- คะแนนการปฏิบัติงาน — ปรับ 3 เรื่องหลังใช้งานจริง
--   1. WFH: engine ต้องรู้ว่าวันนั้นทำงานนอกสถานที่ และ HR ปรับกติกาแยกได้
--   2. กติกาสะสม: สาย/ขาดซ้ำ ๆ ต้องหักหนักขึ้น ไม่ใช่หักเท่าเดิมทุกครั้ง
--   3. ตั้งค่ารอบ: ปิดรอบวันที่เท่าไหร่ · รับรองเวลาย้อนหลังได้กี่วัน · ทักท้วงได้กี่วัน
--
-- IDEMPOTENT: safe to re-run
-- =============================================================================

-- ─── 1. กติกา: ขอบเขตการใช้ + ฐานการนับของกติกาสะสม ──────────────────────────

-- กติกานี้ใช้กับวันแบบไหน: ทุกวัน / เฉพาะวันเข้าออฟฟิศ / เฉพาะวันทำงานนอกสถานที่
ALTER TABLE hr_score_rules ADD COLUMN IF NOT EXISTS applies_to TEXT NOT NULL DEFAULT 'all';
ALTER TABLE hr_score_rules DROP CONSTRAINT IF EXISTS hr_score_rules_applies_to_check;
ALTER TABLE hr_score_rules ADD CONSTRAINT hr_score_rules_applies_to_check
  CHECK (applies_to IN ('all', 'onsite', 'remote'));

-- กติกาสะสม: นับเหตุการณ์ที่ event_code ขึ้นต้นด้วยค่านี้ (เช่น 'late_' = ทุกขั้นความสาย)
-- threshold_min = จำนวนครั้งที่ยอมให้ต่อเดือน · points = หักต่อครั้งที่เกินจากนั้น
ALTER TABLE hr_score_rules ADD COLUMN IF NOT EXISTS counts_event_prefix TEXT;

COMMENT ON COLUMN hr_score_rules.applies_to IS 'all | onsite | remote — วันทำงานนอกสถานที่ (WFH) นับเป็น remote';
COMMENT ON COLUMN hr_score_rules.counts_event_prefix IS 'กติกาสะสมเท่านั้น: นับเหตุการณ์ที่ event_code ขึ้นต้นด้วยค่านี้ในเดือนเดียวกัน';

-- ─── 2. Seed กติกาสะสม ──────────────────────────────────────────────────────
INSERT INTO hr_score_rules
  (category_id, group_code, event_code, name, points, threshold_min, counts_event_prefix, sort_order)
SELECT c.id, v.group_code, v.event_code, v.name, v.points, v.threshold_min, v.counts_event_prefix, v.sort_order
FROM hr_score_categories c
CROSS JOIN (VALUES
  ('attendance_cumulative', 'late_repeat',   'สายเกิน 5 ครั้ง/เดือน (หักเพิ่มครั้งละ)',  -2::NUMERIC, 5::INT, 'late_'::TEXT,  10::INT),
  ('attendance_cumulative', 'absent_repeat', 'ขาดงานเกิน 1 ครั้ง/เดือน (หักเพิ่มครั้งละ)', -5::NUMERIC, 1::INT, 'absent'::TEXT, 20::INT)
) AS v(group_code, event_code, name, points, threshold_min, counts_event_prefix, sort_order)
WHERE c.code = 'discipline'
ON CONFLICT (event_code) DO NOTHING;

-- ─── 3. hr_score_settings — ค่ากลางของรอบคะแนน (แถวเดียว) ───────────────────
CREATE TABLE IF NOT EXISTS hr_score_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ปิดรอบของเดือนก่อนหน้า เมื่อถึงวันที่นี้ของเดือนถัดไป (เช่น 5 = ปิดรอบ ส.ค. ในวันที่ 5 ก.ย.)
  lock_day_of_month INT NOT NULL DEFAULT 5,
  -- true = หน้า HR ปิดรอบที่ถึงกำหนดให้อัตโนมัติ, false = HR กดปิดเอง
  auto_lock BOOLEAN NOT NULL DEFAULT false,
  -- พนักงานยื่นทักท้วงคะแนนได้ภายในกี่วันนับจากวันเกิดเหตุ
  appeal_days INT NOT NULL DEFAULT 7,
  -- หัวหน้ารับรองเวลาย้อนหลังได้ไม่เกินกี่วัน (HR/admin ข้ามข้อจำกัดนี้ได้)
  certify_back_days INT NOT NULL DEFAULT 7,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (lock_day_of_month BETWEEN 1 AND 28),
  CHECK (appeal_days >= 0),
  CHECK (certify_back_days >= 0)
);

INSERT INTO hr_score_settings (lock_day_of_month, auto_lock, appeal_days, certify_back_days)
SELECT 5, false, 7, 7
WHERE NOT EXISTS (SELECT 1 FROM hr_score_settings);

DROP TRIGGER IF EXISTS trg_hr_score_settings_updated ON hr_score_settings;
CREATE TRIGGER trg_hr_score_settings_updated BEFORE UPDATE ON hr_score_settings
  FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

ALTER TABLE hr_score_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hr_score_settings_select" ON hr_score_settings;
DROP POLICY IF EXISTS "hr_score_settings_manage" ON hr_score_settings;
CREATE POLICY "hr_score_settings_select" ON hr_score_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_score_settings_manage" ON hr_score_settings FOR ALL TO authenticated
  USING (hr_is_admin()) WITH CHECK (hr_is_admin());

-- วันนี้ตามเวลาไทย
CREATE OR REPLACE FUNCTION hr_today_th() RETURNS DATE AS $$
  SELECT (now() AT TIME ZONE 'Asia/Bangkok')::DATE;
$$ LANGUAGE sql STABLE
SET search_path = public;

-- รอบเดือนนี้ถึงกำหนดปิดหรือยัง (ใช้ตัดสินว่า UI ควรปิดรอบให้อัตโนมัติ)
CREATE OR REPLACE FUNCTION hr_score_period_due_for_lock(p_period DATE) RETURNS BOOLEAN AS $$
  SELECT hr_today_th() >= (
    date_trunc('month', p_period)::DATE
    + INTERVAL '1 month'
    + ((COALESCE((SELECT s.lock_day_of_month FROM hr_score_settings s LIMIT 1), 5) - 1) || ' days')::INTERVAL
  )::DATE;
$$ LANGUAGE sql STABLE
SET search_path = public;

-- หัวหน้ารับรองเวลาของวันนี้ได้หรือไม่ (ย้อนหลังได้ไม่เกิน certify_back_days, ล่วงหน้าไม่ได้)
CREATE OR REPLACE FUNCTION hr_score_can_certify_date(p_date DATE) RETURNS BOOLEAN AS $$
  SELECT p_date <= hr_today_th()
     AND p_date >= hr_today_th() - COALESCE((SELECT s.certify_back_days FROM hr_score_settings s LIMIT 1), 7);
$$ LANGUAGE sql STABLE
SET search_path = public;

-- ทักท้วงคะแนนของวันนี้ได้หรือไม่
CREATE OR REPLACE FUNCTION hr_score_can_appeal_date(p_date DATE) RETURNS BOOLEAN AS $$
  SELECT hr_today_th() <= p_date + COALESCE((SELECT s.appeal_days FROM hr_score_settings s LIMIT 1), 7);
$$ LANGUAGE sql STABLE
SET search_path = public;

-- ─── 4. บังคับกรอบเวลาใน RLS ────────────────────────────────────────────────
-- หัวหน้ารับรองย้อนหลังได้เท่าที่ตั้งค่าไว้ · HR/admin ข้ามได้ (มีเคสจำเป็น) แต่รอบที่ปิดแล้วห้ามทุกคน
DROP POLICY IF EXISTS "hr_time_cert_insert" ON hr_time_certifications;
DROP POLICY IF EXISTS "hr_time_cert_update" ON hr_time_certifications;
CREATE POLICY "hr_time_cert_insert" ON hr_time_certifications FOR INSERT TO authenticated
  WITH CHECK (
    hr_can_certify_time(employee_id)
    AND (hr_is_admin() OR hr_score_can_certify_date(work_date))
    AND NOT hr_score_period_locked(employee_id, work_date)
  );
CREATE POLICY "hr_time_cert_update" ON hr_time_certifications FOR UPDATE TO authenticated
  USING (
    hr_can_certify_time(employee_id)
    AND (hr_is_admin() OR hr_score_can_certify_date(work_date))
    AND NOT hr_score_period_locked(employee_id, work_date)
  )
  WITH CHECK (hr_can_certify_time(employee_id));

-- ทักท้วงได้ภายในกรอบเวลาที่ตั้งไว้ และเฉพาะรอบที่ยังไม่ปิด
DROP POLICY IF EXISTS "hr_score_appeals_insert" ON hr_score_appeals;
CREATE POLICY "hr_score_appeals_insert" ON hr_score_appeals FOR INSERT TO authenticated
  WITH CHECK (
    employee_id = hr_my_employee_id()
    AND EXISTS (
      SELECT 1 FROM hr_score_events ev
      WHERE ev.id = score_event_id
        AND ev.employee_id = hr_my_employee_id()
        AND hr_score_can_appeal_date(ev.event_date)
        AND NOT hr_score_period_locked(ev.employee_id, ev.event_date)
    )
  );

-- =============================================================================
-- 5. hr_attendance_facts — เพิ่มรูปแบบการทำงาน (WFH) เข้าไปในข้อเท็จจริงรายวัน
--    แทนที่เวอร์ชันใน migration 327 (เปลี่ยน RETURNS TABLE จึงต้อง DROP ก่อน)
-- =============================================================================
DROP FUNCTION IF EXISTS hr_attendance_facts(DATE, DATE, UUID);

CREATE OR REPLACE FUNCTION hr_attendance_facts(
  p_from DATE,
  p_to DATE,
  p_employee UUID DEFAULT NULL
)
RETURNS TABLE (
  employee_id UUID,
  employee_code TEXT,
  employee_name TEXT,
  department_id UUID,
  work_date DATE,
  day_type TEXT,
  work_mode TEXT,
  is_remote_day BOOLEAN,
  expected_start_min INT,
  expected_end_min INT,
  grace_min INT,
  actual_in_min INT,
  actual_in_source TEXT,
  actual_in_ref UUID,
  actual_out_min INT,
  actual_out_source TEXT,
  actual_out_ref UUID,
  ot_in_min INT,
  ot_in_ref UUID,
  ot_request_id UUID,
  ot_request_status TEXT,
  ot_request_created_date DATE,
  ot_request_created_min INT,
  leave_id UUID,
  leave_status TEXT,
  leave_mode TEXT,
  leave_type_name TEXT,
  leave_start_date DATE,
  leave_filed_date DATE,
  leave_filed_min INT,
  leave_start_min INT,
  leave_end_min INT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- SECURITY DEFINER ข้าม RLS — พนักงานทั่วไปดูได้เฉพาะของตัวเอง
  IF NOT hr_is_admin() AND (p_employee IS NULL OR p_employee IS DISTINCT FROM hr_my_employee_id()) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดูข้อมูลเวลาทำงานของพนักงานคนอื่น';
  END IF;

  IF p_to < p_from THEN
    RAISE EXCEPTION 'ช่วงวันที่ไม่ถูกต้อง';
  END IF;

  RETURN QUERY
  WITH default_schedule AS (
    SELECT s.work_start, s.work_end, s.late_grace_min, s.work_days
    FROM hr_work_schedules s
    WHERE s.is_active
    ORDER BY s.is_default DESC, s.created_at
    LIMIT 1
  ),
  clock_fallback AS (
    SELECT s.work_start, s.work_end, s.late_grace_min, s.work_days
    FROM hr_clock_settings s
    LIMIT 1
  ),
  emp AS (
    SELECT
      e.id,
      e.employee_code,
      TRIM(e.first_name || ' ' || e.last_name) AS full_name,
      e.department_id,
      e.hire_date,
      e.work_mode,
      COALESCE(es.work_start, ds.work_start, cf.work_start, TIME '08:00') AS work_start,
      COALESCE(es.work_end, ds.work_end, cf.work_end, TIME '17:00') AS work_end,
      COALESCE(es.late_grace_min, ds.late_grace_min, cf.late_grace_min, 0) AS late_grace_min,
      COALESCE(es.work_days, ds.work_days, cf.work_days, '1,2,3,4,5,6') AS work_days
    FROM hr_employees e
    LEFT JOIN hr_work_schedules es ON es.id = e.work_schedule_id AND es.is_active
    LEFT JOIN default_schedule ds ON true
    LEFT JOIN clock_fallback cf ON true
    WHERE e.employment_status IN ('active', 'probation')
      AND (p_employee IS NULL OR e.id = p_employee)
  ),
  days AS (
    SELECT gs::DATE AS d FROM generate_series(p_from, p_to, INTERVAL '1 day') gs
  ),
  base AS (
    SELECT emp.*, days.d
    FROM emp
    CROSS JOIN days
    WHERE emp.hire_date IS NULL OR days.d >= emp.hire_date
  )
  SELECT
    b.id,
    b.employee_code,
    b.full_name,
    b.department_id,
    b.d,
    CASE
      WHEN cal.id IS NOT NULL THEN cal.day_type
      WHEN hol.id IS NOT NULL THEN 'company_holiday'
      WHEN EXTRACT(ISODOW FROM b.d)::TEXT = ANY (string_to_array(b.work_days, ',')) THEN 'work'
      ELSE 'weekly_off'
    END AS day_type,
    b.work_mode,
    -- ทำงานนอกสถานที่: WFH ประจำ หรือ hybrid ที่มีใบ WFH อนุมัติครอบคลุมวันนี้
    (b.work_mode = 'wfh' OR wfh.id IS NOT NULL) AS is_remote_day,
    (EXTRACT(HOUR FROM eff_start) * 60 + EXTRACT(MINUTE FROM eff_start))::INT AS expected_start_min,
    (EXTRACT(HOUR FROM eff_end) * 60 + EXTRACT(MINUTE FROM eff_end))::INT AS expected_end_min,
    COALESCE(cal_sched.late_grace_min, b.late_grace_min)::INT AS grace_min,

    COALESCE(tin.min_of_day, cin.min_of_day)::INT AS actual_in_min,
    CASE WHEN tin.id IS NOT NULL THEN 'entry' WHEN cin.id IS NOT NULL THEN 'certified' END AS actual_in_source,
    COALESCE(tin.id, cin.id) AS actual_in_ref,

    COALESCE(tout.min_of_day, cout.min_of_day)::INT AS actual_out_min,
    CASE WHEN tout.id IS NOT NULL THEN 'entry' WHEN cout.id IS NOT NULL THEN 'certified' END AS actual_out_source,
    COALESCE(tout.id, cout.id) AS actual_out_ref,

    otin.min_of_day::INT AS ot_in_min,
    otin.id AS ot_in_ref,
    otr.id AS ot_request_id,
    otr.status AS ot_request_status,
    (otr.created_at AT TIME ZONE 'Asia/Bangkok')::DATE AS ot_request_created_date,
    (EXTRACT(HOUR FROM otr.created_at AT TIME ZONE 'Asia/Bangkok') * 60
      + EXTRACT(MINUTE FROM otr.created_at AT TIME ZONE 'Asia/Bangkok'))::INT AS ot_request_created_min,

    lv.id AS leave_id,
    lv.status AS leave_status,
    lv.leave_mode,
    lv.type_name AS leave_type_name,
    lv.start_date AS leave_start_date,
    (lv.created_at AT TIME ZONE 'Asia/Bangkok')::DATE AS leave_filed_date,
    (EXTRACT(HOUR FROM lv.created_at AT TIME ZONE 'Asia/Bangkok') * 60
      + EXTRACT(MINUTE FROM lv.created_at AT TIME ZONE 'Asia/Bangkok'))::INT AS leave_filed_min,
    (EXTRACT(HOUR FROM lv.start_time) * 60 + EXTRACT(MINUTE FROM lv.start_time))::INT AS leave_start_min,
    (EXTRACT(HOUR FROM lv.end_time) * 60 + EXTRACT(MINUTE FROM lv.end_time))::INT AS leave_end_min
  FROM base b
  LEFT JOIN hr_employee_work_calendar cal ON cal.employee_id = b.id AND cal.work_date = b.d
  LEFT JOIN hr_work_schedules cal_sched ON cal_sched.id = cal.work_schedule_id
  LEFT JOIN hr_company_holidays hol ON hol.holiday_date = b.d
  CROSS JOIN LATERAL (
    SELECT
      COALESCE(cal.work_start, cal_sched.work_start, b.work_start) AS eff_start,
      COALESCE(cal.work_end, cal_sched.work_end, b.work_end) AS eff_end
  ) eff
  -- ใบ WFH ที่อนุมัติแล้วครอบคลุมวันนี้
  LEFT JOIN LATERAL (
    SELECT w.id
    FROM hr_wfh_requests w
    WHERE w.employee_id = b.id AND w.status = 'approved'
      AND w.start_date <= b.d AND w.end_date >= b.d
    LIMIT 1
  ) wfh ON true
  -- เข้างานครั้งแรกของวัน
  LEFT JOIN LATERAL (
    SELECT te.id, EXTRACT(EPOCH FROM ((te.entry_time AT TIME ZONE 'Asia/Bangkok') - b.d::TIMESTAMP)) / 60 AS min_of_day
    FROM hr_time_entries te
    WHERE te.employee_id = b.id AND te.work_date = b.d AND te.entry_type = 'clock_in'
    ORDER BY te.entry_time
    LIMIT 1
  ) tin ON true
  -- ออกงานครั้งสุดท้ายของวัน
  LEFT JOIN LATERAL (
    SELECT te.id, EXTRACT(EPOCH FROM ((te.entry_time AT TIME ZONE 'Asia/Bangkok') - b.d::TIMESTAMP)) / 60 AS min_of_day
    FROM hr_time_entries te
    WHERE te.employee_id = b.id AND te.work_date = b.d AND te.entry_type = 'clock_out'
    ORDER BY te.entry_time DESC
    LIMIT 1
  ) tout ON true
  -- เริ่ม OT ครั้งแรกของวัน
  LEFT JOIN LATERAL (
    SELECT te.id, EXTRACT(EPOCH FROM ((te.entry_time AT TIME ZONE 'Asia/Bangkok') - b.d::TIMESTAMP)) / 60 AS min_of_day
    FROM hr_time_entries te
    WHERE te.employee_id = b.id AND te.work_date = b.d AND te.entry_type = 'ot_in'
    ORDER BY te.entry_time
    LIMIT 1
  ) otin ON true
  -- ใบรับรองเวลาของหัวหน้า (ใช้เมื่อไม่มีบันทึกจริง)
  LEFT JOIN LATERAL (
    SELECT tc.id, EXTRACT(EPOCH FROM ((tc.certified_time AT TIME ZONE 'Asia/Bangkok') - b.d::TIMESTAMP)) / 60 AS min_of_day
    FROM hr_time_certifications tc
    WHERE tc.employee_id = b.id AND tc.work_date = b.d AND tc.entry_type = 'clock_in'
  ) cin ON true
  LEFT JOIN LATERAL (
    SELECT tc.id, EXTRACT(EPOCH FROM ((tc.certified_time AT TIME ZONE 'Asia/Bangkok') - b.d::TIMESTAMP)) / 60 AS min_of_day
    FROM hr_time_certifications tc
    WHERE tc.employee_id = b.id AND tc.work_date = b.d AND tc.entry_type = 'clock_out'
  ) cout ON true
  -- ใบลาที่ครอบคลุมวันนี้ — อนุมัติแล้วมาก่อน แล้วค่อยเป็นใบที่ยังรออนุมัติ
  LEFT JOIN LATERAL (
    SELECT lr.id, lr.status, lr.leave_mode, lr.start_date, lr.created_at,
           lr.start_time, lr.end_time, lt.name AS type_name
    FROM hr_leave_requests lr
    LEFT JOIN hr_leave_types lt ON lt.id = lr.leave_type_id
    WHERE lr.employee_id = b.id
      AND lr.start_date <= b.d AND lr.end_date >= b.d
      AND lr.status IN ('approved', 'pending')
    ORDER BY CASE lr.status WHEN 'approved' THEN 0 ELSE 1 END, lr.created_at
    LIMIT 1
  ) lv ON true
  -- คำขอ OT ของวันนี้ — อนุมัติแล้วมาก่อน
  LEFT JOIN LATERAL (
    SELECT r.id, r.status, r.created_at
    FROM hr_ot_requests r
    WHERE r.employee_id = b.id AND r.request_date = b.d
      AND r.status IN ('approved', 'pending', 'rejected')
    ORDER BY CASE r.status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, r.created_at
    LIMIT 1
  ) otr ON true
  -- วันหยุดที่ไม่มีความเคลื่อนไหวเลย ไม่ต้องส่งกลับไปให้ engine
  WHERE cal.day_type = 'work'
     OR (cal.id IS NULL AND hol.id IS NULL
         AND EXTRACT(ISODOW FROM b.d)::TEXT = ANY (string_to_array(b.work_days, ',')))
     OR tin.id IS NOT NULL OR tout.id IS NOT NULL OR otin.id IS NOT NULL
     OR cin.id IS NOT NULL OR cout.id IS NOT NULL
  ORDER BY b.full_name, b.d;
END;
$$;

REVOKE ALL ON FUNCTION hr_attendance_facts(DATE, DATE, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hr_attendance_facts(DATE, DATE, UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
