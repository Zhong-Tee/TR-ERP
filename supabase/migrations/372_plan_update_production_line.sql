-- Let Plan editors and production change a department's production line,
-- including after manpower has been locked. Keep worker assignments in sync.

CREATE OR REPLACE FUNCTION public.plan_update_job_line_assignment(
  p_plan_job_id text,
  p_department_name text,
  p_line_index integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_line_assignments jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.us_users u
    WHERE u.id = auth.uid()
      AND u.role IN ('superadmin', 'admin', 'production')
  ) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไขไลน์ผลิต';
  END IF;

  IF NULLIF(btrim(p_department_name), '') IS NULL OR p_line_index < 0 THEN
    RAISE EXCEPTION 'ข้อมูลไลน์ผลิตไม่ถูกต้อง';
  END IF;

  UPDATE public.plan_jobs
  SET line_assignments = jsonb_set(
    COALESCE(line_assignments, '{}'::jsonb),
    ARRAY[p_department_name],
    to_jsonb(p_line_index),
    true
  )
  WHERE id = p_plan_job_id
  RETURNING line_assignments INTO v_line_assignments;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบใบงาน';
  END IF;

  UPDATE public.plan_worker_assignments
  SET line_no = p_line_index + 1,
      updated_at = now()
  WHERE plan_job_id = p_plan_job_id
    AND department_name = p_department_name
    AND status <> 'cancelled';

  RETURN v_line_assignments;
END;
$$;

REVOKE ALL ON FUNCTION public.plan_update_job_line_assignment(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plan_update_job_line_assignment(text, text, integer) TO authenticated;
