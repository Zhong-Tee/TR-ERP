-- Safe employee directory for Plan manpower views.
-- Production needs names in assignment/report views, but must not receive
-- unrestricted SELECT access to sensitive columns in hr_employees.

CREATE OR REPLACE FUNCTION public.plan_list_employees()
RETURNS TABLE (
  id uuid,
  employee_code text,
  first_name text,
  last_name text,
  nickname text,
  employment_status text,
  department jsonb,
  "position" jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    e.id,
    e.employee_code,
    e.first_name,
    e.last_name,
    e.nickname,
    e.employment_status,
    CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object('name', d.name) END,
    CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('name', p.name) END
  FROM public.hr_employees e
  LEFT JOIN public.hr_departments d ON d.id = e.department_id
  LEFT JOIN public.hr_positions p ON p.id = e.position_id
  WHERE EXISTS (
    SELECT 1
    FROM public.us_users u
    WHERE u.id = auth.uid()
      AND u.role IN ('superadmin', 'admin', 'production')
  )
  ORDER BY e.employee_code;
$$;

REVOKE ALL ON FUNCTION public.plan_list_employees() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plan_list_employees() TO authenticated;

