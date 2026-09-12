-- Allow production role to update confirm board statuses (limited scope)
-- Allowed statuses: ตรวจสอบแล้ว (Order ใหม่), รอออกแบบ, ออกแบบแล้ว

BEGIN;

DROP POLICY IF EXISTS "Production can update limited confirm statuses" ON or_orders;

CREATE POLICY "Production can update limited confirm statuses"
  ON or_orders FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM us_users
      WHERE id = auth.uid()
        AND role = 'production'
    )
    AND channel_code = 'PUMP'
    AND status IN ('ตรวจสอบแล้ว', 'รอออกแบบ', 'ออกแบบแล้ว')
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM us_users
      WHERE id = auth.uid()
        AND role = 'production'
    )
    AND channel_code = 'PUMP'
    AND status IN ('ตรวจสอบแล้ว', 'รอออกแบบ', 'ออกแบบแล้ว')
  );

COMMIT;
