-- ให้ role มือถือที่ใช้หน้า Machinery อัปเดตสถานะเครื่องได้ (เดิม UPDATE ได้แค่ superadmin/admin/production)
DROP POLICY IF EXISTS "pr_machinery_machines_update" ON pr_machinery_machines;
CREATE POLICY "pr_machinery_machines_update" ON pr_machinery_machines
  FOR UPDATE TO authenticated
  USING (
    check_user_role(auth.uid(), ARRAY[
      'superadmin', 'admin', 'production', 'production_mb', 'manager', 'technician'
    ])
  )
  WITH CHECK (
    check_user_role(auth.uid(), ARRAY[
      'superadmin', 'admin', 'production', 'production_mb', 'manager', 'technician'
    ])
  );
