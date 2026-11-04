-- หลัง migration 137 (rename admin-tr/admin-pump -> sales-tr/sales-pump) policy ใน 060 ยังอ้างชื่อเก่า
-- อัปเดตให้สอดคล้อง role ปัจจุบัน (ไม่ใช้ admin-tr/admin-pump แล้ว)

-- ====== ac_verified_slips ======
DROP POLICY IF EXISTS "Order and account staff can manage verified slips" ON ac_verified_slips;

CREATE POLICY "Order and account staff can manage verified slips"
  ON ac_verified_slips FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN (
          'superadmin',
          'admin',
          'sales-tr',
          'sales-pump',
          'account'
        )
    )
  );

-- ====== ac_slip_verification_logs ======
DROP POLICY IF EXISTS "Order and account staff can manage slip verification logs" ON ac_slip_verification_logs;

CREATE POLICY "Order and account staff can manage slip verification logs"
  ON ac_slip_verification_logs FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN (
          'superadmin',
          'admin',
          'sales-tr',
          'sales-pump',
          'account'
        )
    )
  );
