-- Sync valid assignments and release only assignments that collide after a schedule change.
DROP FUNCTION IF EXISTS public.plan_sync_job_manpower_schedule(TEXT, JSONB, JSONB);

CREATE FUNCTION public.plan_sync_job_manpower_schedule(p_plan_job_id TEXT, p_schedules JSONB, p_line_assignments JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.plan_jobs;
  v_assignment public.plan_worker_assignments;
  v_conflict public.plan_worker_assignments;
  v_schedule JSONB;
  v_row JSONB;
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  v_line INT;
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
    v_schedule := COALESCE(p_schedules -> (v_assignment.department_name || '|' || v_assignment.process_name), p_schedules -> v_assignment.department_name);
    IF v_schedule IS NULL THEN RAISE EXCEPTION 'ไม่พบเวลาของ % / %', v_assignment.department_name, v_assignment.process_name; END IF;
    v_start := (v_job.date || 'T' || (v_schedule->>'start') || ':00+07:00')::TIMESTAMPTZ;
    v_end := (v_job.date || 'T' || (v_schedule->>'end') || ':00+07:00')::TIMESTAMPTZ;
    IF v_end <= v_start THEN v_start := v_end - INTERVAL '1 minute'; END IF;
    v_line := GREATEST(1, COALESCE((p_line_assignments->>v_assignment.department_name)::INT,0)+1);

    SELECT x.* INTO v_conflict FROM public.plan_worker_assignments x
    WHERE x.employee_id=v_assignment.employee_id AND x.id<>v_assignment.id
      AND x.status NOT IN ('cancelled','completed')
      AND (x.plan_job_id<>p_plan_job_id OR x.id<v_assignment.id)
      AND tstzrange(date_trunc('minute',x.planned_start),date_trunc('minute',x.planned_end),'[)')
          && tstzrange(date_trunc('minute',v_start),date_trunc('minute',v_end),'[)')
    ORDER BY x.planned_start,x.id LIMIT 1;

    IF FOUND THEN
      IF v_assignment.status='in_progress' THEN RAISE EXCEPTION 'พนักงานในกระบวนการ % กำลังทำงานและชนกับแผนเวลาใหม่',v_assignment.process_name; END IF;
      UPDATE public.plan_worker_assignments SET status='cancelled',score_detail=COALESCE(score_detail,'{}'::JSONB)||jsonb_build_object('cancel_reason','schedule_conflict','cancelled_at',now(),'proposed_start',v_start,'proposed_end',v_end,'conflict_assignment_id',v_conflict.id,'conflict_plan_job_id',v_conflict.plan_job_id) WHERE id=v_assignment.id;
      v_reassignments:=v_reassignments||jsonb_build_array(jsonb_build_object('assignment_id',v_assignment.id,'employee_id',v_assignment.employee_id,'department_name',v_assignment.department_name,'process_name',v_assignment.process_name,'proposed_start',v_start,'proposed_end',v_end,'conflict_plan_job_id',v_conflict.plan_job_id,'conflict_process_name',v_conflict.process_name,'conflict_start',v_conflict.planned_start,'conflict_end',v_conflict.planned_end));
      CONTINUE;
    END IF;

    UPDATE public.plan_worker_assignments SET line_no=v_line,planned_start=v_start,planned_end=v_end WHERE id=v_assignment.id RETURNING to_jsonb(plan_worker_assignments) INTO v_row;
    v_synced:=v_synced||jsonb_build_array(v_row);
  END LOOP;
  RETURN jsonb_build_object('assignments',v_synced,'reassignments',v_reassignments);
END;
$$;

REVOKE ALL ON FUNCTION public.plan_sync_job_manpower_schedule(TEXT,JSONB,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plan_sync_job_manpower_schedule(TEXT,JSONB,JSONB) TO authenticated;
NOTIFY pgrst,'reload schema';
