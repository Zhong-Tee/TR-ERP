-- ให้ role ที่เข้า "ตั้งค่า Role" ได้ (sales-tr) บันทึก st_user_menus ได้
-- เดิมอนุญาตเฉพาะ superadmin/admin ทำให้ติ๊กแล้วบันทึกไม่ติด / ข้อมูลไม่อัปเดต
BEGIN;

DROP POLICY IF EXISTS "Admins can manage menu permissions" ON st_user_menus;

CREATE POLICY "Admins can manage menu permissions"
  ON st_user_menus FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'sales-tr')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'sales-tr')
    )
  );

COMMIT;
