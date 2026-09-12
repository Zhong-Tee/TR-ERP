-- บันทึกร่างบิลเคลม: เพิ่มสถานะ 'draft' + policy ให้เจ้าของแก้ไข/ส่งอนุมัติ/ลบร่างได้
-- ร่างเห็น/แก้ได้เฉพาะเจ้าของ (submitted_by = auth.uid()) — ส่งอนุมัติ = เปลี่ยน draft -> pending

BEGIN;

-- 1) ขยาย CHECK ของ status ให้รวม 'draft' (เดิม: pending/approved/rejected — 228)
ALTER TABLE or_claim_requests DROP CONSTRAINT IF EXISTS or_claim_requests_status_check;
ALTER TABLE or_claim_requests
  ADD CONSTRAINT or_claim_requests_status_check
  CHECK (status IN ('draft', 'pending', 'approved', 'rejected'));

-- 2) UPDATE: เจ้าของแก้ร่างของตัวเองได้ และเปลี่ยน draft -> pending (ส่งอนุมัติ) ได้
--    บิลอ้างอิงต้องเป็น 'จัดส่งแล้ว' เหมือนตอน insert (228)
DROP POLICY IF EXISTS "or_claim_requests_update_draft_owner" ON or_claim_requests;
CREATE POLICY "or_claim_requests_update_draft_owner"
  ON or_claim_requests FOR UPDATE
  TO authenticated
  USING (
    status = 'draft'
    AND submitted_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM us_users u
      WHERE u.id = auth.uid()
        AND u.role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'qc_order', 'account')
    )
  )
  WITH CHECK (
    status IN ('draft', 'pending')
    AND submitted_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM us_users u
      WHERE u.id = auth.uid()
        AND u.role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'qc_order', 'account')
    )
    AND EXISTS (
      SELECT 1 FROM or_orders o
      WHERE o.id = or_claim_requests.ref_order_id
        AND o.status = 'จัดส่งแล้ว'
    )
  );

-- 3) DELETE: เจ้าของลบร่างของตัวเองได้ (เฉพาะสถานะ draft)
DROP POLICY IF EXISTS "or_claim_requests_delete_draft_owner" ON or_claim_requests;
CREATE POLICY "or_claim_requests_delete_draft_owner"
  ON or_claim_requests FOR DELETE
  TO authenticated
  USING (status = 'draft' AND submitted_by = auth.uid());

COMMENT ON POLICY "or_claim_requests_update_draft_owner" ON or_claim_requests IS
  'เจ้าของแก้ร่างเคลม/ส่งอนุมัติ (draft->pending) ได้ (293)';
COMMENT ON POLICY "or_claim_requests_delete_draft_owner" ON or_claim_requests IS
  'เจ้าของลบร่างเคลมของตัวเองได้ (293)';

COMMIT;
