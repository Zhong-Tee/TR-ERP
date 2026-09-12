-- ให้ sales-tr / sales-pump อ่านผลตรวจสลิปมือได้ (อ่านอย่างเดียว)
-- เพื่อให้บิลที่ตรวจสลิปมือถูกปฏิเสธ แสดงในเมนูออเดอร์ -> ตรวจสอบไม่ผ่าน (ป้าย "ไม่อนุมัติ")
-- การตรวจ/ตัดสินยังเป็นสิทธิ์ของบัญชีตาม policy write เดิม

DROP POLICY IF EXISTS "ac_manual_slip_checks read" ON ac_manual_slip_checks;
CREATE POLICY "ac_manual_slip_checks read"
  ON ac_manual_slip_checks FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'account')
    )
  );
