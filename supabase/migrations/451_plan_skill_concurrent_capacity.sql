-- Configure concurrent assignment capacity per employee/process skill instead
-- of applying one capacity to every process handled by an employee.
ALTER TABLE public.plan_employee_skills
  ADD COLUMN IF NOT EXISTS max_concurrent_jobs SMALLINT NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plan_employee_skills_max_concurrent_jobs_check'
      AND conrelid = 'public.plan_employee_skills'::regclass
  ) THEN
    ALTER TABLE public.plan_employee_skills
      ADD CONSTRAINT plan_employee_skills_max_concurrent_jobs_check
      CHECK (max_concurrent_jobs BETWEEN 1 AND 20);
  END IF;
END $$;

-- Preserve the capacity configured before this migration by applying it to
-- every existing skill. Users can then tune each process independently.
UPDATE public.plan_employee_skills skill
SET max_concurrent_jobs = COALESCE(profile.max_concurrent_jobs, 1)
FROM public.plan_employee_profiles profile
WHERE profile.employee_id = skill.employee_id;

COMMENT ON COLUMN public.plan_employee_skills.max_concurrent_jobs IS
  'จำนวนงานสูงสุดที่พนักงานรับพร้อมกันได้เมื่อถูกจัดสรรให้กระบวนการนี้; ช่วงคาบเกี่ยวไม่เกิน 5 นาทีไม่นับเป็นงานซ้อน';

CREATE OR REPLACE FUNCTION public.plan_employee_process_capacity(
  p_employee_id UUID,
  p_department_name TEXT,
  p_process_name TEXT
) RETURNS INTEGER
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT skill.max_concurrent_jobs
      FROM public.plan_employee_skills skill
      WHERE skill.employee_id = p_employee_id
        AND skill.department_name = p_department_name
        AND skill.process_name = p_process_name
    ),
    (
      SELECT profile.max_concurrent_jobs
      FROM public.plan_employee_profiles profile
      WHERE profile.employee_id = p_employee_id
    ),
    1
  )::INTEGER;
$$;

REVOKE ALL ON FUNCTION public.plan_employee_process_capacity(UUID,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plan_employee_process_capacity(UUID,TEXT,TEXT) TO authenticated;

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
  v_capacity INTEGER := 1;
  v_peak INTEGER := 0;
BEGIN
  IF NOT public.hr_is_admin() THEN RAISE EXCEPTION 'ไม่มีสิทธิ์จัดสรรกำลังคน'; END IF;
  IF p_planned_end <= p_planned_start THEN RAISE EXCEPTION 'ช่วงเวลาจัดสรรไม่ถูกต้อง'; END IF;
  IF p_assignment_role NOT IN ('operator','supervisor') THEN RAISE EXCEPTION 'ประเภทการจัดสรรไม่ถูกต้อง'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_employee_id::TEXT));
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

CREATE OR REPLACE FUNCTION public.plan_sync_job_manpower_schedule(
  p_plan_job_id TEXT,
  p_schedules JSONB,
  p_line_assignments JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.plan_jobs;
  v_assignment public.plan_worker_assignments;
  v_conflict public.plan_worker_assignments;
  v_schedule JSONB;
  v_row JSONB;
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  v_line INT;
  v_capacity INT;
  v_peak INT;
  v_synced JSONB := '[]'::JSONB;
  v_reassignments JSONB := '[]'::JSONB;
BEGIN
  IF NOT public.hr_is_admin() THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ปรับแผนกำลังคน'; END IF;
  SELECT * INTO v_job FROM public.plan_jobs WHERE id = p_plan_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบใบงาน'; END IF;
  IF v_job.manpower_locked_at IS NOT NULL THEN RAISE EXCEPTION 'ใบงานนี้บันทึกและล็อกกำลังคนแล้ว กรุณาปลดล็อกก่อนเปลี่ยนแผน'; END IF;

  FOR v_assignment IN
    SELECT * FROM public.plan_worker_assignments
    WHERE plan_job_id = p_plan_job_id AND status NOT IN ('cancelled','completed')
    ORDER BY id FOR UPDATE
  LOOP
    v_schedule := COALESCE(
      p_schedules -> (v_assignment.department_name || '|' || v_assignment.process_name),
      p_schedules -> v_assignment.department_name
    );
    IF v_schedule IS NULL THEN RAISE EXCEPTION 'ไม่พบเวลาของ % / %', v_assignment.department_name, v_assignment.process_name; END IF;
    v_start := (v_job.date || 'T' || (v_schedule->>'start') || ':00+07:00')::TIMESTAMPTZ;
    v_end := (v_job.date || 'T' || (v_schedule->>'end') || ':00+07:00')::TIMESTAMPTZ;
    IF v_end <= v_start THEN v_start := v_end - INTERVAL '1 minute'; END IF;
    v_line := GREATEST(1, COALESCE((p_line_assignments->>v_assignment.department_name)::INT,0)+1);
    v_capacity := public.plan_employee_process_capacity(
      v_assignment.employee_id,
      v_assignment.department_name,
      v_assignment.process_name
    );
    v_peak := public.plan_assignment_peak_load(
      v_assignment.employee_id, v_start, v_end, v_assignment.id,
      p_plan_job_id, v_assignment.id
    );

    IF v_peak >= v_capacity THEN
      SELECT x.* INTO v_conflict FROM public.plan_worker_assignments x
      WHERE x.employee_id = v_assignment.employee_id AND x.id <> v_assignment.id
        AND x.status NOT IN ('cancelled','completed')
        AND (x.plan_job_id <> p_plan_job_id OR x.id < v_assignment.id)
        AND LEAST(x.planned_end, v_end) - GREATEST(x.planned_start, v_start) > INTERVAL '5 minutes'
      ORDER BY x.planned_start, x.id LIMIT 1;
      IF v_assignment.status = 'in_progress' THEN
        RAISE EXCEPTION 'พนักงานในกระบวนการ % กำลังทำงานและเกินจำนวนงานซ้อนสูงสุดของกระบวนการ', v_assignment.process_name;
      END IF;
      UPDATE public.plan_worker_assignments
      SET status = 'cancelled', score_detail = COALESCE(score_detail,'{}'::JSONB) || jsonb_build_object(
        'cancel_reason','schedule_capacity_conflict','capacity_scope','employee_process',
        'max_concurrent_jobs',v_capacity,'cancelled_at',now(),
        'proposed_start',v_start,'proposed_end',v_end,
        'conflict_assignment_id',v_conflict.id,'conflict_plan_job_id',v_conflict.plan_job_id
      ) WHERE id = v_assignment.id;
      v_reassignments := v_reassignments || jsonb_build_array(jsonb_build_object(
        'assignment_id',v_assignment.id,'employee_id',v_assignment.employee_id,
        'department_name',v_assignment.department_name,'process_name',v_assignment.process_name,
        'proposed_start',v_start,'proposed_end',v_end,
        'conflict_plan_job_id',v_conflict.plan_job_id,'conflict_process_name',v_conflict.process_name,
        'conflict_start',v_conflict.planned_start,'conflict_end',v_conflict.planned_end
      ));
      CONTINUE;
    END IF;

    UPDATE public.plan_worker_assignments
    SET line_no = v_line, planned_start = v_start, planned_end = v_end,
        score_detail = COALESCE(score_detail,'{}'::JSONB) || jsonb_build_object(
          'max_concurrent_jobs',v_capacity,'capacity_scope','employee_process'
        )
    WHERE id = v_assignment.id
    RETURNING to_jsonb(plan_worker_assignments) INTO v_row;
    v_synced := v_synced || jsonb_build_array(v_row);
  END LOOP;
  RETURN jsonb_build_object('assignments',v_synced,'reassignments',v_reassignments);
END;
$$;

REVOKE ALL ON FUNCTION public.plan_sync_job_manpower_schedule(TEXT,JSONB,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plan_sync_job_manpower_schedule(TEXT,JSONB,JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';
