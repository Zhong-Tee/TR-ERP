-- Rename a Plan department without leaving stale department keys in jobs or manpower data.
CREATE OR REPLACE FUNCTION public.plan_apply_department_rename(
  p_old_name TEXT,
  p_new_name TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_old TEXT := btrim(COALESCE(p_old_name, ''));
  v_new TEXT := btrim(COALESCE(p_new_name, ''));
  v_data JSONB;
  v_key TEXT;
  v_object JSONB;
BEGIN
  IF v_old = '' OR v_new = '' THEN
    RAISE EXCEPTION 'ชื่อแผนกต้องไม่เป็นค่าว่าง';
  END IF;
  IF v_old = v_new THEN
    SELECT data INTO v_data FROM public.plan_settings WHERE id = 1;
    RETURN COALESCE(v_data, '{}'::JSONB);
  END IF;

  SELECT data INTO v_data
  FROM public.plan_settings
  WHERE id = 1
  FOR UPDATE;

  IF v_data IS NULL THEN
    RAISE EXCEPTION 'ไม่พบการตั้งค่าแผนการผลิต';
  END IF;

  -- A normal rename must not overwrite another department. If the old name is
  -- already absent, allow this call to repair stale rows left by an older rename.
  IF (v_data->'departments') ? v_old AND (v_data->'departments') ? v_new THEN
    RAISE EXCEPTION 'มีแผนกชื่อ % อยู่แล้ว', v_new;
  END IF;

  IF (v_data->'departments') ? v_old THEN
    v_data := jsonb_set(
      v_data,
      '{departments}',
      COALESCE((
        SELECT jsonb_agg(to_jsonb(CASE WHEN value = v_old THEN v_new ELSE value END) ORDER BY ordinality)
        FROM jsonb_array_elements_text(v_data->'departments') WITH ORDINALITY AS item(value, ordinality)
      ), '[]'::JSONB),
      true
    );
  END IF;

  FOREACH v_key IN ARRAY ARRAY[
    'processes', 'prepPerJob', 'startDelayPerJob', 'deptBreaks',
    'linesPerDept', 'departmentProductCategories'
  ] LOOP
    v_object := COALESCE(v_data->v_key, '{}'::JSONB);
    IF v_object ? v_old THEN
      v_object := (v_object - v_old)
        || jsonb_build_object(v_new, COALESCE(v_object->v_new, v_object->v_old));
      v_data := jsonb_set(v_data, ARRAY[v_key], v_object, true);
    END IF;
  END LOOP;

  UPDATE public.plan_jobs
  SET qty = CASE WHEN qty ? v_old THEN (qty - v_old) || jsonb_build_object(v_new, COALESCE(qty->v_new, qty->v_old)) ELSE qty END,
      tracks = CASE WHEN tracks ? v_old THEN (tracks - v_old) || jsonb_build_object(v_new, COALESCE(tracks->v_new, tracks->v_old)) ELSE tracks END,
      line_assignments = CASE WHEN line_assignments ? v_old THEN (line_assignments - v_old) || jsonb_build_object(v_new, COALESCE(line_assignments->v_new, line_assignments->v_old)) ELSE line_assignments END,
      manual_plan_starts = CASE WHEN manual_plan_starts ? v_old THEN (manual_plan_starts - v_old) || jsonb_build_object(v_new, COALESCE(manual_plan_starts->v_new, manual_plan_starts->v_old)) ELSE manual_plan_starts END,
      locked_plans = CASE WHEN locked_plans ? v_old THEN (locked_plans - v_old) || jsonb_build_object(v_new, COALESCE(locked_plans->v_new, locked_plans->v_old)) ELSE locked_plans END,
      follow_notes = CASE WHEN follow_notes ? v_old THEN (follow_notes - v_old) || jsonb_build_object(v_new, COALESCE(follow_notes->v_new, follow_notes->v_old)) ELSE follow_notes END
  WHERE qty ? v_old OR tracks ? v_old OR line_assignments ? v_old
     OR manual_plan_starts ? v_old OR locked_plans ? v_old OR follow_notes ? v_old;

  -- Prefer records already created under the new name when both names exist.
  DELETE FROM public.plan_employee_skills old_row
  USING public.plan_employee_skills new_row
  WHERE old_row.department_name = v_old
    AND new_row.department_name = v_new
    AND new_row.employee_id = old_row.employee_id
    AND new_row.process_name = old_row.process_name;
  UPDATE public.plan_employee_skills SET department_name = v_new WHERE department_name = v_old;

  DELETE FROM public.plan_operation_requirements old_row
  USING public.plan_operation_requirements new_row
  WHERE old_row.department_name = v_old
    AND new_row.department_name = v_new
    AND new_row.process_name = old_row.process_name;
  UPDATE public.plan_operation_requirements SET department_name = v_new WHERE department_name = v_old;

  -- Cancel only an obsolete active duplicate before changing the remaining history.
  UPDATE public.plan_worker_assignments old_row
  SET status = 'cancelled'
  WHERE old_row.department_name = v_old
    AND old_row.status NOT IN ('cancelled', 'completed')
    AND EXISTS (
      SELECT 1
      FROM public.plan_worker_assignments new_row
      WHERE new_row.department_name = v_new
        AND new_row.plan_job_id = old_row.plan_job_id
        AND new_row.employee_id = old_row.employee_id
        AND new_row.process_name = old_row.process_name
        AND new_row.assignment_role = old_row.assignment_role
        AND new_row.status NOT IN ('cancelled', 'completed')
    );
  UPDATE public.plan_worker_assignments SET department_name = v_new WHERE department_name = v_old;

  UPDATE public.pr_machinery_machines SET department_name = v_new WHERE department_name = v_old;

  UPDATE public.plan_settings
  SET data = v_data, updated_at = now()
  WHERE id = 1;

  RETURN v_data;
END;
$$;

REVOKE ALL ON FUNCTION public.plan_apply_department_rename(TEXT, TEXT) FROM PUBLIC, authenticated;

CREATE OR REPLACE FUNCTION public.plan_rename_department(
  p_old_name TEXT,
  p_new_name TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid() AND role IN ('superadmin', 'admin')
  ) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์เปลี่ยนชื่อแผนก';
  END IF;
  RETURN public.plan_apply_department_rename(p_old_name, p_new_name);
END;
$$;

REVOKE ALL ON FUNCTION public.plan_rename_department(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plan_rename_department(TEXT, TEXT) TO authenticated;

-- Repair the rename that happened before cascade support was added.
DO $$
DECLARE
  v_data JSONB;
BEGIN
  SELECT data INTO v_data FROM public.plan_settings WHERE id = 1;
  IF COALESCE(v_data->'departments', '[]'::JSONB) ? 'CTT'
     AND NOT (COALESCE(v_data->'departments', '[]'::JSONB) ? 'CTT&SUB') THEN
    PERFORM public.plan_apply_department_rename('CTT&SUB', 'CTT');
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
