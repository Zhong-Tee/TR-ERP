-- Employee Portal: today's time entries visible by department.
-- superadmin/admin/account can see everyone; other roles only their own department.

CREATE OR REPLACE FUNCTION hr_portal_visible_time_entries(p_work_date DATE DEFAULT ((now() AT TIME ZONE 'Asia/Bangkok')::DATE))
RETURNS TABLE (
  id UUID,
  employee_id UUID,
  employee_code TEXT,
  employee_name TEXT,
  nickname TEXT,
  department_id UUID,
  department_name TEXT,
  entry_type TEXT,
  work_date DATE,
  entry_time TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_department_id UUID;
BEGIN
  SELECT u.role INTO v_role FROM us_users u WHERE u.id = auth.uid();
  SELECT e.department_id INTO v_department_id FROM hr_employees e WHERE e.user_id = auth.uid() LIMIT 1;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;
  IF v_role NOT IN ('superadmin', 'admin', 'account') AND v_department_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    te.id,
    e.id,
    e.employee_code,
    TRIM(CONCAT_WS(' ', e.first_name, e.last_name)),
    e.nickname,
    e.department_id,
    d.name,
    te.entry_type,
    te.work_date,
    te.entry_time
  FROM hr_time_entries te
  JOIN hr_employees e ON e.id = te.employee_id
  LEFT JOIN hr_departments d ON d.id = e.department_id
  WHERE te.work_date = p_work_date
    AND e.employment_status IN ('active', 'probation')
    AND (
      v_role IN ('superadmin', 'admin', 'account')
      OR e.department_id = v_department_id
    )
  ORDER BY e.first_name, e.last_name, te.entry_time;
END;
$$;

REVOKE ALL ON FUNCTION hr_portal_visible_time_entries(DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hr_portal_visible_time_entries(DATE) TO authenticated;

NOTIFY pgrst, 'reload schema';
