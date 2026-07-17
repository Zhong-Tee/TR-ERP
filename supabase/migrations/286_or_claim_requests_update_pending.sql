-- แก้ไขบิลเคลม (proposed_snapshot) ได้ตลอดจนกว่าจะถูกอนุมัติ/ปฏิเสธ
-- อนุญาตเฉพาะ role เดียวกับที่ส่งคำขอเคลมได้ และเฉพาะคำขอสถานะ pending เท่านั้น
-- WITH CHECK บังคับให้แถวหลังแก้ยังเป็น pending — เปลี่ยนสถานะได้ผ่าน rpc อนุมัติ/ปฏิเสธเท่านั้น
DROP POLICY IF EXISTS "or_claim_requests_update_pending_authorized" ON or_claim_requests;

CREATE POLICY "or_claim_requests_update_pending_authorized"
  ON or_claim_requests FOR UPDATE
  TO authenticated
  USING (
    status = 'pending'
    AND EXISTS (
      SELECT 1 FROM us_users u
      WHERE u.id = auth.uid()
        AND u.role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'qc_order', 'account')
    )
  )
  WITH CHECK (
    status = 'pending'
    AND EXISTS (
      SELECT 1 FROM us_users u
      WHERE u.id = auth.uid()
        AND u.role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'qc_order', 'account')
    )
  );

COMMENT ON POLICY "or_claim_requests_update_pending_authorized" ON or_claim_requests IS
  'แก้ไขคำขอเคลมได้เฉพาะสถานะ pending โดย role ที่ส่งเคลมได้ (286)';
