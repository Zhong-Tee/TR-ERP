-- Replace team-based task assignment with an explicit list of employees who
-- may assign work and review work that they assigned.

CREATE TABLE IF NOT EXISTS public.hr_task_assigner_permissions (
  employee_id UUID PRIMARY KEY REFERENCES public.hr_employees(id) ON DELETE CASCADE,
  granted_by UUID REFERENCES public.hr_employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.hr_task_assigner_permissions ENABLE ROW LEVEL SECURITY;

-- Preserve the people who could assign through the former team setup so the
-- rollout does not unexpectedly remove their access. Administrators can edit
-- this list from the new screen afterward.
INSERT INTO public.hr_task_assigner_permissions (employee_id)
SELECT DISTINCT member.employee_id
FROM public.hr_task_team_members member
WHERE member.can_assign OR member.role = 'manager'
ON CONFLICT (employee_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.hr_task_permission_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.us_users
    WHERE id = auth.uid()
      AND role IN ('superadmin', 'admin', 'hr', 'account')
  );
$$;

CREATE OR REPLACE FUNCTION public.hr_task_can_assign()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.hr_task_permission_admin()
    OR EXISTS (
      SELECT 1
      FROM public.hr_task_assigner_permissions permission
      WHERE permission.employee_id = public.hr_my_employee_id()
    );
$$;

DROP POLICY IF EXISTS "hr_task_assigner_permissions_read" ON public.hr_task_assigner_permissions;
CREATE POLICY "hr_task_assigner_permissions_read"
ON public.hr_task_assigner_permissions
FOR SELECT TO authenticated
USING (public.hr_task_permission_admin() OR employee_id = public.hr_my_employee_id());

DROP POLICY IF EXISTS "hr_task_assigner_permissions_manage" ON public.hr_task_assigner_permissions;
CREATE POLICY "hr_task_assigner_permissions_manage"
ON public.hr_task_assigner_permissions
FOR ALL TO authenticated
USING (public.hr_task_permission_admin())
WITH CHECK (public.hr_task_permission_admin());

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

-- A selected assigner needs the active employee list in order to choose an
-- assignee. Existing HR/account administrators retain their current access.
DROP POLICY IF EXISTS "hr_employees_task_assigners_select" ON public.hr_employees;
CREATE POLICY "hr_employees_task_assigners_select"
ON public.hr_employees
FOR SELECT TO authenticated
USING (public.hr_task_can_assign());

-- Creating a task is now allowed only for task administrators or employees in
-- the explicit assigner list. The creator remains the supervisor/reviewer of
-- the task through the existing participant and evaluation policies.
DROP POLICY IF EXISTS "hr_tasks_create" ON public.hr_tasks;
CREATE POLICY "hr_tasks_create"
ON public.hr_tasks
FOR INSERT TO authenticated
WITH CHECK (
  created_by = public.hr_my_employee_id()
  AND public.hr_task_can_assign()
);
