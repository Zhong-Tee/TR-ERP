-- ให้ sales-tr / sales-pump อ่านรายการโอนคืนได้ (อ่านอย่างเดียว)
-- เพื่อแสดงป้าย "ปฏิเสธโอนคืน" + เหตุผลไม่อนุมัติ บนการ์ดบิลในเมนูออเดอร์
-- policy เดิมจาก 001 ใช้ role เก่า (admin, order_staff) ที่เลิกใช้แล้ว — sales จึงอ่านไม่ได้
-- การอนุมัติ/ปฏิเสธยังเป็นสิทธิ์ของบัญชีตาม policy "Account staff can manage refunds" เหมือนเดิม

DROP POLICY IF EXISTS "Order staff can view refunds" ON ac_refunds;
CREATE POLICY "Order staff can view refunds"
  ON ac_refunds FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'account')
    )
  );
