-- =============================================================================
-- ลางาน: รองรับช่วงลาแบบชั่วโมง (นอกจากเต็มวัน)
--   leave_mode: full_day | hourly
--   hourly → เก็บ start_time, end_time, total_hours (วันเดียว)
-- อัปเดต get_employee_leave_summary ให้คืนฟิลด์ใหม่ใน recent_requests
-- IDEMPOTENT: safe to re-run
-- =============================================================================

ALTER TABLE hr_leave_requests ADD COLUMN IF NOT EXISTS leave_mode TEXT NOT NULL DEFAULT 'full_day';
ALTER TABLE hr_leave_requests ADD COLUMN IF NOT EXISTS start_time TIME;
ALTER TABLE hr_leave_requests ADD COLUMN IF NOT EXISTS end_time TIME;
ALTER TABLE hr_leave_requests ADD COLUMN IF NOT EXISTS total_hours NUMERIC(5,2);

ALTER TABLE hr_leave_requests DROP CONSTRAINT IF EXISTS hr_leave_requests_leave_mode_check;
ALTER TABLE hr_leave_requests ADD CONSTRAINT hr_leave_requests_leave_mode_check
  CHECK (leave_mode IN ('full_day', 'hourly'));

CREATE OR REPLACE FUNCTION get_employee_leave_summary(p_employee_id UUID, p_year INT)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'balances', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', t.id,
        'leave_type_id', t.id,
        'leave_type_name', t.name,
        'entitled_days', COALESCE(t.max_days_per_year, 0),
        'used_days', COALESCE(u.used, 0),
        'carried_days', 0,
        'remaining', GREATEST(0, COALESCE(t.max_days_per_year, 0) - COALESCE(u.used, 0))
      ) ORDER BY t.name)
      FROM hr_leave_types t
      LEFT JOIN (
        SELECT leave_type_id, SUM(total_days) AS used
        FROM hr_leave_requests
        WHERE employee_id = p_employee_id
          AND status = 'approved'
          AND EXTRACT(YEAR FROM start_date) = p_year
        GROUP BY leave_type_id
      ) u ON u.leave_type_id = t.id
    ), '[]'::jsonb),
    'recent_requests', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', r.id,
        'leave_type_name', t.name,
        'start_date', r.start_date,
        'end_date', r.end_date,
        'total_days', r.total_days,
        'leave_mode', r.leave_mode,
        'start_time', r.start_time,
        'end_time', r.end_time,
        'total_hours', r.total_hours,
        'status', r.status,
        'reason', r.reason,
        'medical_cert_url', r.medical_cert_url,
        'created_at', r.created_at
      ) ORDER BY r.created_at DESC)
      FROM hr_leave_requests r
      JOIN hr_leave_types t ON t.id = r.leave_type_id
      WHERE r.employee_id = p_employee_id
        AND EXTRACT(YEAR FROM r.start_date) = p_year
    ), '[]'::jsonb),
    'pending_count', (
      SELECT count(*) FROM hr_leave_requests
      WHERE employee_id = p_employee_id AND status = 'pending'
    )
  ) INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
