-- Keep manpower assignments aligned when a work order moves to another line.
CREATE OR REPLACE FUNCTION plan_sync_job_manpower_schedule(
  p_plan_job_id TEXT,
  p_schedules JSONB,
  p_line_assignments JSONB
) RETURNS SETOF plan_worker_assignments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job plan_jobs;
  v_a plan_worker_assignments;
  v_b plan_worker_assignments;
  v_schedule JSONB;
  v_other_schedule JSONB;
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  v_other_start TIMESTAMPTZ;
  v_other_end TIMESTAMPTZ;
  v_line INT;
BEGIN
  IF NOT hr_is_admin() THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ปรับแผนกำลังคน'; END IF;

  SELECT * INTO v_job FROM plan_jobs WHERE id = p_plan_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบใบงาน'; END IF;
  IF v_job.manpower_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'ใบงานนี้บันทึกและล็อกกำลังคนแล้ว กรุณาปลดล็อกก่อนเปลี่ยนไลน์';
  END IF;

  -- Validate every proposed range before changing any row.
  FOR v_a IN
    SELECT * FROM plan_worker_assignments
    WHERE plan_job_id = p_plan_job_id AND status NOT IN ('cancelled','completed')
    FOR UPDATE
  LOOP
    v_schedule := COALESCE(p_schedules -> (v_a.department_name || '|' || v_a.process_name), p_schedules -> v_a.department_name);
    IF v_schedule IS NULL THEN RAISE EXCEPTION 'ไม่พบเวลาของ % / %', v_a.department_name, v_a.process_name; END IF;
    v_start := (v_job.date || 'T' || (v_schedule->>'start') || ':00+07:00')::timestamptz;
    v_end := (v_job.date || 'T' || (v_schedule->>'end') || ':00+07:00')::timestamptz;
    IF v_end <= v_start THEN v_start := v_end - interval '1 minute'; END IF;

    IF EXISTS (
      SELECT 1 FROM plan_worker_assignments x
      WHERE x.employee_id = v_a.employee_id
        AND x.plan_job_id <> p_plan_job_id
        AND x.status NOT IN ('cancelled','completed')
        AND tstzrange(date_trunc('minute',x.planned_start),date_trunc('minute',x.planned_end),'[)')
            && tstzrange(date_trunc('minute',v_start),date_trunc('minute',v_end),'[)')
    ) THEN
      RAISE EXCEPTION 'เปลี่ยนไลน์ไม่ได้: พนักงานในกระบวนการ % มีงานอื่นชนช่วงเวลาใหม่', v_a.process_name;
    END IF;

    FOR v_b IN
      SELECT * FROM plan_worker_assignments
      WHERE plan_job_id = p_plan_job_id AND employee_id = v_a.employee_id
        AND id > v_a.id AND status NOT IN ('cancelled','completed')
    LOOP
      v_other_schedule := COALESCE(p_schedules -> (v_b.department_name || '|' || v_b.process_name), p_schedules -> v_b.department_name);
      IF v_other_schedule IS NULL THEN CONTINUE; END IF;
      v_other_start := (v_job.date || 'T' || (v_other_schedule->>'start') || ':00+07:00')::timestamptz;
      v_other_end := (v_job.date || 'T' || (v_other_schedule->>'end') || ':00+07:00')::timestamptz;
      IF v_other_end <= v_other_start THEN v_other_start := v_other_end - interval '1 minute'; END IF;
      IF tstzrange(date_trunc('minute',v_start),date_trunc('minute',v_end),'[)')
          && tstzrange(date_trunc('minute',v_other_start),date_trunc('minute',v_other_end),'[)') THEN
        RAISE EXCEPTION 'เปลี่ยนไลน์ไม่ได้: พนักงานมีช่วงงานใหม่ทับกันระหว่าง % และ %', v_a.process_name, v_b.process_name;
      END IF;
    END LOOP;
  END LOOP;

  FOR v_a IN
    SELECT * FROM plan_worker_assignments
    WHERE plan_job_id = p_plan_job_id AND status NOT IN ('cancelled','completed')
  LOOP
    v_schedule := COALESCE(p_schedules -> (v_a.department_name || '|' || v_a.process_name), p_schedules -> v_a.department_name);
    v_start := (v_job.date || 'T' || (v_schedule->>'start') || ':00+07:00')::timestamptz;
    v_end := (v_job.date || 'T' || (v_schedule->>'end') || ':00+07:00')::timestamptz;
    IF v_end <= v_start THEN v_start := v_end - interval '1 minute'; END IF;
    v_line := GREATEST(1,COALESCE((p_line_assignments->>v_a.department_name)::int,0)+1);
    UPDATE plan_worker_assignments SET line_no=v_line,planned_start=v_start,planned_end=v_end WHERE id=v_a.id;
  END LOOP;

  RETURN QUERY SELECT * FROM plan_worker_assignments
    WHERE plan_job_id=p_plan_job_id AND status NOT IN ('cancelled','completed');
END;
$$;

REVOKE ALL ON FUNCTION plan_sync_job_manpower_schedule(TEXT,JSONB,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION plan_sync_job_manpower_schedule(TEXT,JSONB,JSONB) TO authenticated;
NOTIFY pgrst, 'reload schema';
