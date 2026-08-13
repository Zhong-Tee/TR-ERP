-- Manpower schedules are planned and displayed at minute precision.
-- Normalize both stored and requested ranges to the same precision so a task
-- ending during 15:24 can be followed by the next task starting at 15:24.
CREATE OR REPLACE FUNCTION plan_assign_worker(
  p_plan_job_id TEXT,
  p_employee_id UUID,
  p_department_name TEXT,
  p_process_name TEXT,
  p_line_no INT,
  p_planned_start TIMESTAMPTZ,
  p_planned_end TIMESTAMPTZ,
  p_assignment_role TEXT DEFAULT 'operator',
  p_score NUMERIC DEFAULT NULL,
  p_score_detail JSONB DEFAULT '{}'::JSONB
) RETURNS plan_worker_assignments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row plan_worker_assignments;
  v_start TIMESTAMPTZ := date_trunc('minute', p_planned_start);
  v_end TIMESTAMPTZ := date_trunc('minute', p_planned_end);
BEGIN
  IF NOT hr_is_admin() THEN RAISE EXCEPTION 'ไม่มีสิทธิ์จัดสรรกำลังคน'; END IF;
  IF v_end <= v_start THEN RAISE EXCEPTION 'ช่วงเวลาจัดสรรไม่ถูกต้อง'; END IF;
  IF p_assignment_role NOT IN ('operator','supervisor') THEN RAISE EXCEPTION 'ประเภทการจัดสรรไม่ถูกต้อง'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_employee_id::TEXT));
  IF EXISTS (
    SELECT 1 FROM plan_worker_assignments a
    WHERE a.employee_id = p_employee_id
      AND a.status NOT IN ('cancelled','completed')
      AND tstzrange(date_trunc('minute', a.planned_start), date_trunc('minute', a.planned_end), '[)')
          && tstzrange(v_start, v_end, '[)')
  ) THEN
    RAISE EXCEPTION 'พนักงานถูกจัดสรรในช่วงเวลานี้แล้ว';
  END IF;

  INSERT INTO plan_worker_assignments(
    plan_job_id, employee_id, department_name, process_name, line_no,
    planned_start, planned_end, status, assignment_source, assignment_role,
    score, score_detail, assigned_by
  ) VALUES (
    p_plan_job_id, p_employee_id, p_department_name, p_process_name, GREATEST(1,p_line_no),
    v_start, v_end, 'confirmed', 'manual', p_assignment_role,
    p_score, COALESCE(p_score_detail,'{}'::JSONB), auth.uid()
  ) RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION plan_assign_worker(TEXT,UUID,TEXT,TEXT,INT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,NUMERIC,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION plan_assign_worker(TEXT,UUID,TEXT,TEXT,INT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,NUMERIC,JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';
