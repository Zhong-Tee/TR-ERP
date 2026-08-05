-- =============================================================================
-- ปฏิทินลา (ทั้งบริษัท) สำหรับ Employee Portal
--   RLS ของ hr_leave_requests ให้พนักงานเห็นเฉพาะใบลาของตัวเอง จึงต้องใช้ RPC
--   SECURITY DEFINER ที่คืนเฉพาะข้อมูลที่จำเป็นต่อการแสดงปฏิทิน
--   (ชื่อ/ตำแหน่ง/ช่วงวัน/สถานะ — ไม่มีเหตุผลลา ประเภทลา หรือใบรับรองแพทย์)
--   สิทธิ์เรียก: superadmin / admin / account เท่านั้น
-- IDEMPOTENT: safe to re-run
-- =============================================================================

CREATE OR REPLACE FUNCTION hr_can_view_leave_calendar() RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM us_users
    WHERE id = auth.uid() AND role IN ('superadmin','admin','account')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public;

DROP FUNCTION IF EXISTS get_leave_calendar(DATE, DATE);
CREATE FUNCTION get_leave_calendar(p_start DATE, p_end DATE)
RETURNS TABLE (
  id UUID,
  employee_id UUID,
  employee_name TEXT,
  position_name TEXT,
  department_name TEXT,
  start_date DATE,
  end_date DATE,
  leave_mode TEXT,
  start_time TIME,
  end_time TIME,
  status TEXT
) AS $$
BEGIN
  IF NOT hr_can_view_leave_calendar() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดูปฏิทินลา';
  END IF;

  RETURN QUERY
  SELECT
    r.id,
    r.employee_id,
    (trim(concat_ws(' ', e.first_name, e.last_name))
      || CASE WHEN coalesce(e.nickname, '') <> '' THEN ' (' || e.nickname || ')' ELSE '' END)::TEXT,
    p.name::TEXT,
    d.name::TEXT,
    r.start_date,
    r.end_date,
    r.leave_mode::TEXT,
    r.start_time,
    r.end_time,
    r.status::TEXT
  FROM hr_leave_requests r
  JOIN hr_employees e ON e.id = r.employee_id
  LEFT JOIN hr_positions p ON p.id = e.position_id
  LEFT JOIN hr_departments d ON d.id = e.department_id
  WHERE r.status IN ('approved','pending')
    AND r.start_date <= p_end
    AND r.end_date >= p_start
  ORDER BY r.start_date, e.first_name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public;

REVOKE ALL ON FUNCTION get_leave_calendar(DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_leave_calendar(DATE, DATE) TO authenticated;

NOTIFY pgrst, 'reload schema';
