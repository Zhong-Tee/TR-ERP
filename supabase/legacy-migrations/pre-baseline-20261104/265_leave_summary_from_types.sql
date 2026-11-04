-- =============================================================================
-- ปรับ get_employee_leave_summary: คำนวณสิทธิ์การลาจาก hr_leave_types.max_days_per_year
-- − ใบลาที่อนุมัติแล้ว (แหล่งเดียวกับหน้าเดสก์ท็อป) แทนตาราง hr_leave_balances รายคน
-- ทำให้พนักงานทุกคนเห็นวันลาคงเหลือบนมือถือทันที โดยไม่ต้องกรอกสิทธิ์รายคน
-- IDEMPOTENT: CREATE OR REPLACE
-- =============================================================================

CREATE OR REPLACE FUNCTION get_employee_leave_summary(p_employee_id UUID, p_year INT)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    -- สิทธิ์การลาต่อประเภท: entitled = max_days_per_year, used = ผลรวมวันลาที่อนุมัติในปีนั้น
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
