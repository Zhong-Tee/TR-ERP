-- ผู้จัดการยืนยันและล็อกแผนกำลังคนเป็นรายใบงาน
ALTER TABLE plan_jobs
  ADD COLUMN IF NOT EXISTS manpower_locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS manpower_locked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION plan_lock_manpower(p_plan_job_id TEXT)
RETURNS plan_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job plan_jobs;
  v_missing INT;
BEGIN
  IF NOT hr_is_admin() THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ล็อกแผนกำลังคน'; END IF;

  SELECT COALESCE(SUM(
    GREATEST(0, r.required_workers - COALESCE(a.operator_count, 0)) +
    GREATEST(0, r.required_supervisors - COALESCE(a.supervisor_count, 0))
  ), 0)
  INTO v_missing
  FROM plan_jobs j
  CROSS JOIN LATERAL jsonb_each_text(COALESCE(to_jsonb(j.qty), '{}'::jsonb)) qty
  JOIN plan_operation_requirements r ON r.department_name = qty.key
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE w.assignment_role = 'operator') AS operator_count,
      COUNT(*) FILTER (WHERE w.assignment_role = 'supervisor') AS supervisor_count
    FROM plan_worker_assignments w
    WHERE w.plan_job_id = j.id
      AND w.department_name = r.department_name
      AND w.process_name = r.process_name
      AND w.status NOT IN ('cancelled','completed')
  ) a ON true
  WHERE j.id = p_plan_job_id AND COALESCE(NULLIF(qty.value, '')::numeric, 0) > 0;

  -- Client ตรวจความครบตามกระบวนการที่ใช้จริงอีกชั้น; server กันกรณีไม่มีใบงาน
  SELECT * INTO v_job FROM plan_jobs WHERE id = p_plan_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบใบงาน'; END IF;
  IF v_missing > 0 THEN RAISE EXCEPTION 'ยังจัดกำลังคนไม่ครบ % ตำแหน่ง', v_missing; END IF;

  UPDATE plan_jobs
  SET manpower_locked_at = now(), manpower_locked_by = auth.uid()
  WHERE id = p_plan_job_id
  RETURNING * INTO v_job;
  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION plan_lock_manpower(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION plan_lock_manpower(TEXT) TO authenticated;
NOTIFY pgrst, 'reload schema';
