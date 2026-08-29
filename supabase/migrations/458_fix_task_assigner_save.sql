-- Fix environments where migration 457 was already applied. Supabase's safe
-- update guard rejects DELETE statements that do not contain a WHERE clause.
CREATE OR REPLACE FUNCTION public.hr_set_task_assigners(p_employee_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_granted_by UUID := public.hr_my_employee_id();
BEGIN
  IF NOT public.hr_task_permission_admin() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไขรายชื่อผู้มอบหมายงาน';
  END IF;

  DELETE FROM public.hr_task_assigner_permissions
  WHERE NOT (employee_id = ANY(COALESCE(p_employee_ids, ARRAY[]::UUID[])));

  INSERT INTO public.hr_task_assigner_permissions (employee_id, granted_by)
  SELECT DISTINCT selected.employee_id, v_granted_by
  FROM unnest(COALESCE(p_employee_ids, ARRAY[]::UUID[])) AS selected(employee_id)
  JOIN public.hr_employees employee ON employee.id = selected.employee_id
  WHERE employee.employment_status = 'active'
  ON CONFLICT (employee_id) DO UPDATE
  SET granted_by = EXCLUDED.granted_by,
      updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.hr_set_task_assigners(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_set_task_assigners(UUID[]) TO authenticated;
