-- Lock manpower against the processes that are actually present in the job's
-- current schedule. Stale requirement rows from renamed/deleted processes must
-- not prevent a fully staffed job from being locked.
DROP FUNCTION IF EXISTS public.plan_lock_manpower(TEXT);
DROP FUNCTION IF EXISTS public.plan_lock_manpower(TEXT, JSONB);

CREATE FUNCTION public.plan_lock_manpower(
  p_plan_job_id TEXT,
  p_schedules JSONB
) RETURNS public.plan_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.plan_jobs;
  v_missing INT := 0;
  v_process_count INT := 0;
  v_allow_supervisor_as_worker BOOLEAN := false;
BEGIN
  IF NOT public.hr_is_admin() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ล็อกแผนกำลังคน';
  END IF;

  SELECT * INTO v_job
  FROM public.plan_jobs
  WHERE id = p_plan_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบใบงาน';
  END IF;

  IF COALESCE(jsonb_typeof(p_schedules), '') <> 'object' THEN
    RAISE EXCEPTION 'ข้อมูลกระบวนการของใบงานไม่ถูกต้อง กรุณารีเฟรชหน้าแล้วลองใหม่';
  END IF;

  SELECT COUNT(*) INTO v_process_count
  FROM jsonb_object_keys(p_schedules) AS schedule_keys(schedule_key)
  WHERE position('|' IN schedule_key) > 1;

  IF v_process_count = 0 THEN
    RAISE EXCEPTION 'ไม่พบกระบวนการของใบงาน กรุณารีเฟรชหน้าแล้วลองใหม่';
  END IF;

  SELECT COALESCE((data->>'allow_supervisor_as_worker')::BOOLEAN, false)
  INTO v_allow_supervisor_as_worker
  FROM public.plan_settings
  WHERE id = 1;

  SELECT COALESCE(SUM(
    CASE
      WHEN v_allow_supervisor_as_worker AND active.required_supervisors > 0 THEN
        GREATEST(
          GREATEST(
            0,
            active.required_workers
              - (COALESCE(assigned.operator_count, 0) + COALESCE(assigned.supervisor_count, 0))
          ),
          GREATEST(
            0,
            active.required_supervisors - COALESCE(assigned.supervisor_count, 0)
          )
        )
      ELSE
        GREATEST(
          0,
          active.required_workers - COALESCE(assigned.operator_count, 0)
        )
        + GREATEST(
          0,
          active.required_supervisors - COALESCE(assigned.supervisor_count, 0)
        )
    END
  ), 0)::INT
  INTO v_missing
  FROM (
    SELECT
      split_part(schedule_key, '|', 1) AS department_name,
      substring(schedule_key FROM position('|' IN schedule_key) + 1) AS process_name,
      COALESCE(requirement.required_workers, 1) AS required_workers,
      COALESCE(requirement.required_supervisors, 0) AS required_supervisors
    FROM jsonb_object_keys(p_schedules) AS schedule_keys(schedule_key)
    LEFT JOIN public.plan_operation_requirements requirement
      ON requirement.department_name = split_part(schedule_key, '|', 1)
     AND requirement.process_name = substring(schedule_key FROM position('|' IN schedule_key) + 1)
    WHERE position('|' IN schedule_key) > 1
  ) active
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE assignment.assignment_role = 'operator') AS operator_count,
      COUNT(*) FILTER (WHERE assignment.assignment_role = 'supervisor') AS supervisor_count
    FROM public.plan_worker_assignments assignment
    WHERE assignment.plan_job_id = p_plan_job_id
      AND assignment.department_name = active.department_name
      AND assignment.process_name = active.process_name
      -- A completed assignment is still proof that the position was staffed.
      AND assignment.status <> 'cancelled'
  ) assigned ON true;

  IF v_missing > 0 THEN
    RAISE EXCEPTION 'ยังจัดกำลังคนไม่ครบ % ตำแหน่ง', v_missing;
  END IF;

  UPDATE public.plan_jobs
  SET manpower_locked_at = now(), manpower_locked_by = auth.uid()
  WHERE id = p_plan_job_id
  RETURNING * INTO v_job;

  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION public.plan_lock_manpower(TEXT,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plan_lock_manpower(TEXT,JSONB) TO authenticated;

-- Compatibility for an already-open/older browser tab. Build the active
-- process keys from current Plan settings, then use the same strict validator.
CREATE FUNCTION public.plan_lock_manpower(
  p_plan_job_id TEXT
) RETURNS public.plan_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_schedules JSONB := '{}'::JSONB;
BEGIN
  SELECT COALESCE(
    jsonb_object_agg(
      quantity.key || '|' || (process_item->>'name'),
      '{}'::JSONB
    ),
    '{}'::JSONB
  )
  INTO v_schedules
  FROM public.plan_jobs job
  CROSS JOIN LATERAL jsonb_each_text(COALESCE(job.qty, '{}'::JSONB)) quantity
  JOIN public.plan_settings settings ON settings.id = 1
  CROSS JOIN LATERAL jsonb_array_elements(
    COALESCE(settings.data->'processes'->quantity.key, '[]'::JSONB)
  ) process_item
  WHERE job.id = p_plan_job_id
    AND COALESCE(NULLIF(quantity.value, '')::NUMERIC, 0) > 0
    AND NULLIF(process_item->>'name', '') IS NOT NULL;

  RETURN public.plan_lock_manpower(p_plan_job_id, v_schedules);
END;
$$;

REVOKE ALL ON FUNCTION public.plan_lock_manpower(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plan_lock_manpower(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
