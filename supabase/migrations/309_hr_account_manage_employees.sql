-- =============================================================================
-- Migration 309: ให้ role account จัดการทะเบียนพนักงานได้ (เพิ่ม/แก้ไข/ลบ/นำเข้า)
--
-- เดิม (migration 300) account เป็น read-only บนตาราง HR ทั้งหมด ทำให้เมื่อกด
-- Import ในหน้าทะเบียนพนักงาน RLS ฝั่ง UPDATE (USING hr_is_admin() = false)
-- แก้ได้ 0 แถวแบบเงียบ ๆ และ .select().single() คืน error
-- "Cannot coerce the result to a single JSON object"
--
-- เพิ่ม policy แบบ additive เฉพาะตาราง hr_employees (ไม่แตะ policy เดิมของ admin
-- และไม่กระทบสิทธิ์ read-only ของ account บนตาราง HR อื่น ๆ)
-- reuse public.hr_account_can_read_all() ซึ่งเป็น true เมื่อ us_users.role = 'account'
-- =============================================================================

BEGIN;

DROP POLICY IF EXISTS "hr_employees_account_insert" ON hr_employees;
DROP POLICY IF EXISTS "hr_employees_account_update" ON hr_employees;
DROP POLICY IF EXISTS "hr_employees_account_delete" ON hr_employees;

CREATE POLICY "hr_employees_account_insert" ON hr_employees
  FOR INSERT TO authenticated
  WITH CHECK (public.hr_account_can_read_all());

CREATE POLICY "hr_employees_account_update" ON hr_employees
  FOR UPDATE TO authenticated
  USING (public.hr_account_can_read_all())
  WITH CHECK (public.hr_account_can_read_all());

CREATE POLICY "hr_employees_account_delete" ON hr_employees
  FOR DELETE TO authenticated
  USING (public.hr_account_can_read_all());

GRANT INSERT, UPDATE, DELETE ON TABLE hr_employees TO authenticated;

COMMIT;
