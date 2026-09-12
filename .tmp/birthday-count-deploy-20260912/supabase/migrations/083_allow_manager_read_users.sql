-- =====================================================================
-- แก้ RLS: ให้ role manager อ่านข้อมูล us_users ได้
-- เพื่อให้หน้ารายการอนุมัติ (ManagerLayout) สามารถ:
--   1. แสดงชื่อผู้สร้างใบเบิก (created_by)
--   2. โหลดรายชื่อ Picker ใน dropdown ได้
-- =====================================================================

DROP POLICY IF EXISTS "Admins can view all users" ON us_users;

CREATE POLICY "Admins can view all users"
  ON us_users FOR SELECT
  USING (
    auth.uid() = id OR
    check_user_role(auth.uid(), ARRAY['superadmin', 'admin-tr', 'manager'])
  );
