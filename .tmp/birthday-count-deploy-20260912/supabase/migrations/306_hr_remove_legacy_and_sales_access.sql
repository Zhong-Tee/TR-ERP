-- =============================================================================
-- Migration 306: HR role cleanup
--   - admin-tr is not an HR administrator and receives no leave notifications.
--   - sales-tr has no HR parent/submenu access.
--   - account read-only access from migration 300 remains unchanged.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.hr_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.us_users
    WHERE id = auth.uid()
      AND role IN ('superadmin', 'admin', 'hr')
  );
$$;

REVOKE ALL ON FUNCTION public.hr_is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_is_admin() TO authenticated;

-- Preserve the latest leave-notification behavior and only remove admin-tr
-- from its recipient list.
DO $$
DECLARE
  routine_oid oid;
  definition text;
BEGIN
  routine_oid := to_regprocedure('public.hr_leave_notify()');
  IF routine_oid IS NOT NULL THEN
    definition := pg_get_functiondef(routine_oid);
    definition := regexp_replace(
      definition,
      ',[[:space:]]*''admin-tr''',
      '',
      'g'
    );

    IF definition LIKE '%admin-tr%' THEN
      RAISE EXCEPTION 'Unable to safely remove admin-tr from hr_leave_notify';
    END IF;

    EXECUTE definition;
  END IF;
END;
$$;

INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access)
VALUES
  ('sales-tr', 'hr', 'HR', false),
  ('sales-tr', 'hr-employees', 'ทะเบียนพนักงาน', false),
  ('sales-tr', 'hr-leave', 'ระบบลางาน/OT', false),
  ('sales-tr', 'hr-attendance', 'เวลาทำงาน', false),
  ('sales-tr', 'hr-work-calendar', 'ตารางวันทำงานและวันหยุด', false),
  ('sales-tr', 'hr-warnings', 'ใบเตือน', false),
  ('sales-tr', 'hr-certificates', 'ใบรับรอง', false),
  ('sales-tr', 'hr-interview', 'นัดสัมภาษณ์', false),
  ('sales-tr', 'hr-onboarding', 'รับพนักงานใหม่', false),
  ('sales-tr', 'hr-assets', 'ทะเบียนทรัพย์สิน', false),
  ('sales-tr', 'hr-contracts', 'สัญญาจ้าง', false),
  ('sales-tr', 'hr-documents', 'กฎระเบียบ/SOP', false),
  ('sales-tr', 'hr-salary', 'เส้นทางเงินเดือน', false),
  ('sales-tr', 'hr-settings', 'ตั้งค่า HR', false)
ON CONFLICT (role, menu_key)
DO UPDATE SET
  menu_name = EXCLUDED.menu_name,
  has_access = false,
  updated_at = now();

COMMIT;
