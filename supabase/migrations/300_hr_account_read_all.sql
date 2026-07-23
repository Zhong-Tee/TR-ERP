-- =============================================================================
-- Role account: เปิดเมนู HR ทุกเมนูย่อยและอ่านข้อมูลของพนักงานทุกคน
--
-- จงใจให้เฉพาะ SELECT เท่านั้น ไม่เพิ่ม account เข้า hr_is_admin() เพราะ helper
-- ดังกล่าวถูกใช้กับ INSERT / UPDATE / DELETE ในหลายตาราง HR ด้วย
-- =============================================================================

CREATE OR REPLACE FUNCTION public.hr_account_can_read_all()
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
      AND role = 'account'
  );
$$;

REVOKE ALL ON FUNCTION public.hr_account_can_read_all() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_account_can_read_all() TO authenticated;

-- เพิ่ม SELECT policy แยกจาก policy ฝั่ง HR/admin เพื่อคงสิทธิ์ account เป็น read-only
DO $$
DECLARE
  hr_table record;
BEGIN
  FOR hr_table IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename LIKE 'hr\_%' ESCAPE '\'
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      'account_read_all',
      hr_table.schemaname,
      hr_table.tablename
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I FOR SELECT TO authenticated USING (public.hr_account_can_read_all())',
      'account_read_all',
      hr_table.schemaname,
      hr_table.tablename
    );
    EXECUTE format(
      'GRANT SELECT ON TABLE %I.%I TO authenticated',
      hr_table.schemaname,
      hr_table.tablename
    );
  END LOOP;
END;
$$;

-- MenuAccessContext อ่านสิทธิ์จาก st_user_menus จึงต้องมีทั้ง parent และ submenu
INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access)
VALUES
  ('account', 'hr', 'HR', true),
  ('account', 'hr-employees', 'ทะเบียนพนักงาน', true),
  ('account', 'hr-leave', 'ระบบลางาน/OT', true),
  ('account', 'hr-attendance', 'เวลาทำงาน', true),
  ('account', 'hr-work-calendar', 'ตารางวันทำงานและวันหยุด', true),
  ('account', 'hr-warnings', 'ใบเตือน', true),
  ('account', 'hr-certificates', 'ใบรับรอง', true),
  ('account', 'hr-interview', 'นัดสัมภาษณ์', true),
  ('account', 'hr-onboarding', 'รับพนักงานใหม่', true),
  ('account', 'hr-assets', 'ทะเบียนทรัพย์สิน', true),
  ('account', 'hr-contracts', 'สัญญาจ้าง', true),
  ('account', 'hr-documents', 'กฎระเบียบ/SOP', true),
  ('account', 'hr-salary', 'เส้นทางเงินเดือน', true),
  ('account', 'hr-settings', 'ตั้งค่า HR', true)
ON CONFLICT (role, menu_key)
DO UPDATE SET
  menu_name = EXCLUDED.menu_name,
  has_access = EXCLUDED.has_access,
  updated_at = now();

COMMENT ON FUNCTION public.hr_account_can_read_all() IS
  'True only for authenticated users whose us_users.role is account; used by read-only HR RLS policies.';
