-- =============================================================================
-- แก้ hr_attendance_facts: เลิกอ้าง hr_clock_settings
--
-- ตารางนั้นถูก DROP ไปแล้วใน migration 264 (ถูกแทนด้วย hr_work_schedules ใน 263)
-- เวอร์ชันใน 327/328 จึงพังด้วย relation "hr_clock_settings" does not exist
-- ลำดับตารางเวลาใหม่: override รายวัน > ตารางของพนักงาน > ตารางค่าเริ่มต้น > ค่าคงที่
--
-- IDEMPOTENT: safe to re-run
-- =============================================================================

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
  emp AS (
    SELECT
      e.id,
      e.employee_code,
      TRIM(e.first_name || ' ' || e.last_name) AS full_name,
      e.department_id,
      e.hire_date,
      e.work_mode,
      COALESCE(es.work_start, ds.work_start, TIME '08:00') AS work_start,
      COALESCE(es.work_end, ds.work_end, TIME '17:00') AS work_end,
      COALESCE(es.late_grace_min, ds.late_grace_min, 0) AS late_grace_min,
      COALESCE(es.work_days, ds.work_days, '1,2,3,4,5,6') AS work_days
    FROM hr_employees e
    LEFT JOIN hr_work_schedules es ON es.id = e.work_schedule_id AND es.is_active
    LEFT JOIN default_schedule ds ON true
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
  LEFT JOIN LATERAL (
    SELECT w.id
    FROM hr_wfh_requests w
    WHERE w.employee_id = b.id AND w.status = 'approved'
      AND w.start_date <= b.d AND w.end_date >= b.d
    LIMIT 1
  ) wfh ON true
  LEFT JOIN LATERAL (
    SELECT te.id, EXTRACT(EPOCH FROM ((te.entry_time AT TIME ZONE 'Asia/Bangkok') - b.d::TIMESTAMP)) / 60 AS min_of_day
    FROM hr_time_entries te
    WHERE te.employee_id = b.id AND te.work_date = b.d AND te.entry_type = 'clock_in'
    ORDER BY te.entry_time
    LIMIT 1
  ) tin ON true
  LEFT JOIN LATERAL (
    SELECT te.id, EXTRACT(EPOCH FROM ((te.entry_time AT TIME ZONE 'Asia/Bangkok') - b.d::TIMESTAMP)) / 60 AS min_of_day
    FROM hr_time_entries te
    WHERE te.employee_id = b.id AND te.work_date = b.d AND te.entry_type = 'clock_out'
    ORDER BY te.entry_time DESC
    LIMIT 1
  ) tout ON true
  LEFT JOIN LATERAL (
    SELECT te.id, EXTRACT(EPOCH FROM ((te.entry_time AT TIME ZONE 'Asia/Bangkok') - b.d::TIMESTAMP)) / 60 AS min_of_day
    FROM hr_time_entries te
    WHERE te.employee_id = b.id AND te.work_date = b.d AND te.entry_type = 'ot_in'
    ORDER BY te.entry_time
    LIMIT 1
  ) otin ON true
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
  LEFT JOIN LATERAL (
    SELECT r.id, r.status, r.created_at
    FROM hr_ot_requests r
    WHERE r.employee_id = b.id AND r.request_date = b.d
      AND r.status IN ('approved', 'pending', 'rejected')
    ORDER BY CASE r.status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, r.created_at
    LIMIT 1
  ) otr ON true
  WHERE cal.day_type = 'work'
     OR (cal.id IS NULL AND hol.id IS NULL
         AND EXTRACT(ISODOW FROM b.d)::TEXT = ANY (string_to_array(b.work_days, ',')))
     OR tin.id IS NOT NULL OR tout.id IS NOT NULL OR otin.id IS NOT NULL
     OR cin.id IS NOT NULL OR cout.id IS NOT NULL
  ORDER BY b.full_name, b.d;
END;
$$;

NOTIFY pgrst, 'reload schema';
