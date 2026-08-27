-- A supervisor/lead may cover the operator quota in the same process. When an
-- operator is promoted to supervisor, reuse the existing assignment instead
-- of treating the second role as a concurrent job.
CREATE OR REPLACE FUNCTION public.plan_assign_worker(
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
) RETURNS public.plan_worker_assignments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.plan_worker_assignments;
  v_existing public.plan_worker_assignments;
  v_capacity INTEGER := 1;
  v_peak INTEGER := 0;
  v_allow_supervisor_as_worker BOOLEAN := false;
  v_required_supervisors INTEGER := 0;
BEGIN
  IF NOT public.hr_is_admin() THEN RAISE EXCEPTION 'ไม่มีสิทธิ์จัดสรรกำลังคน'; END IF;
  IF p_planned_end <= p_planned_start THEN RAISE EXCEPTION 'ช่วงเวลาจัดสรรไม่ถูกต้อง'; END IF;
  IF p_assignment_role NOT IN ('operator','supervisor') THEN RAISE EXCEPTION 'ประเภทการจัดสรรไม่ถูกต้อง'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_employee_id::TEXT));

  -- Make repeated requests idempotent.
  SELECT * INTO v_existing
  FROM public.plan_worker_assignments
  WHERE plan_job_id = p_plan_job_id
    AND employee_id = p_employee_id
    AND department_name = p_department_name
    AND process_name = p_process_name
    AND assignment_role = p_assignment_role
    AND status NOT IN ('cancelled','completed')
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    RETURN v_existing;
  END IF;

  -- Promoting the current operator to supervisor is a role change, not a new
  -- overlapping job. The same row will subsequently cover both quotas.
  IF p_assignment_role = 'supervisor' THEN
    SELECT * INTO v_existing
    FROM public.plan_worker_assignments
    WHERE plan_job_id = p_plan_job_id
      AND employee_id = p_employee_id
      AND department_name = p_department_name
      AND process_name = p_process_name
      AND assignment_role = 'operator'
      AND status NOT IN ('cancelled','completed')
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
      UPDATE public.plan_worker_assignments
      SET assignment_role = 'supervisor',
          line_no = GREATEST(1, p_line_no),
          planned_start = p_planned_start,
          planned_end = p_planned_end,
          score = p_score,
          score_detail = COALESCE(score_detail, '{}'::JSONB)
            || COALESCE(p_score_detail, '{}'::JSONB)
            || jsonb_build_object(
              'role_promoted_from', 'operator',
              'role_promoted_at', now()
            ),
          updated_at = now()
      WHERE id = v_existing.id
      RETURNING * INTO v_row;
      RETURN v_row;
    END IF;
  END IF;

  -- If a supervisor already covers production, an operator request for the
  -- same person/process is already satisfied and must not create a duplicate.
  IF p_assignment_role = 'operator' THEN
    SELECT * INTO v_existing
    FROM public.plan_worker_assignments
    WHERE plan_job_id = p_plan_job_id
      AND employee_id = p_employee_id
      AND department_name = p_department_name
      AND process_name = p_process_name
      AND assignment_role = 'supervisor'
      AND status NOT IN ('cancelled','completed')
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
      SELECT COALESCE((data->>'allow_supervisor_as_worker')::BOOLEAN, false)
      INTO v_allow_supervisor_as_worker
      FROM public.plan_settings
      WHERE id = 1;

      SELECT COALESCE(required_supervisors, 0)
      INTO v_required_supervisors
      FROM public.plan_operation_requirements
      WHERE department_name = p_department_name
        AND process_name = p_process_name;

      IF v_allow_supervisor_as_worker AND COALESCE(v_required_supervisors, 0) > 0 THEN
        RETURN v_existing;
      END IF;

      RAISE EXCEPTION 'พนักงานถูกจัดเป็นหัวหน้าคุมงานของกระบวนการนี้แล้ว';
    END IF;
  END IF;

  v_capacity := public.plan_employee_process_capacity(
    p_employee_id, p_department_name, p_process_name
  );
  v_peak := public.plan_assignment_peak_load(
    p_employee_id, p_planned_start, p_planned_end
  );

  IF v_peak >= v_capacity THEN
    RAISE EXCEPTION 'พนักงานรับงานกระบวนการ % พร้อมกันครบจำนวนสูงสุดแล้ว (% งาน) และช่วงคาบเกี่ยวเกิน 5 นาที', p_process_name, v_capacity;
  END IF;

  INSERT INTO public.plan_worker_assignments(
    plan_job_id, employee_id, department_name, process_name, line_no,
    planned_start, planned_end, status, assignment_source, assignment_role,
    score, score_detail, assigned_by
  ) VALUES (
    p_plan_job_id, p_employee_id, p_department_name, p_process_name, GREATEST(1,p_line_no),
    p_planned_start, p_planned_end, 'confirmed', 'manual', p_assignment_role,
    p_score, COALESCE(p_score_detail,'{}'::JSONB) || jsonb_build_object(
      'max_concurrent_jobs', v_capacity,
      'capacity_scope', 'employee_process',
      'overlap_tolerance_minutes', 5
    ), auth.uid()
  ) RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.plan_assign_worker(TEXT,UUID,TEXT,TEXT,INT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,NUMERIC,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plan_assign_worker(TEXT,UUID,TEXT,TEXT,INT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,NUMERIC,JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';
