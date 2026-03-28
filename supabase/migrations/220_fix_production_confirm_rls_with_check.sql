-- แก้ RLS production บน or_orders:
-- 1) WITH CHECK เดิมอนุญาตแค่ 3 สถานะ — อัปเดตเป็น "ไม่ต้องออกแบบ" / รอคอนเฟิร์ม / ฯลฯ จึงล้มเสมอ
-- 2) USING เดิมเฉพาะ PUMP — บิลช่องอื่นที่เข้าคิว Confirm (requires_confirm_design) อัปเดตไม่ได้

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
    AND (
      (
        channel_code = 'PUMP'
        AND status IN (
          'ตรวจสอบแล้ว',
          'ไม่ต้องออกแบบ',
          'รอออกแบบ',
          'ออกแบบแล้ว',
          'รอคอนเฟิร์ม',
          'คอนเฟิร์มแล้ว',
          'เสร็จสิ้น'
        )
      )
      OR (
        COALESCE(channel_code, '') IS DISTINCT FROM 'PUMP'
        AND COALESCE(requires_confirm_design, false) = true
        AND status IN (
          'ตรวจสอบแล้ว',
          'ไม่ต้องออกแบบ',
          'รอออกแบบ',
          'ออกแบบแล้ว',
          'รอคอนเฟิร์ม',
          'คอนเฟิร์มแล้ว',
          'เสร็จสิ้น'
        )
      )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM us_users
      WHERE id = auth.uid()
        AND role = 'production'
    )
    AND (
      (
        channel_code = 'PUMP'
        AND status IN (
          'ตรวจสอบแล้ว',
          'ไม่ต้องออกแบบ',
          'รอออกแบบ',
          'ออกแบบแล้ว',
          'รอคอนเฟิร์ม',
          'คอนเฟิร์มแล้ว',
          'เสร็จสิ้น'
        )
      )
      OR (
        COALESCE(channel_code, '') IS DISTINCT FROM 'PUMP'
        AND COALESCE(requires_confirm_design, false) = true
        AND status IN (
          'ตรวจสอบแล้ว',
          'ไม่ต้องออกแบบ',
          'รอออกแบบ',
          'ออกแบบแล้ว',
          'รอคอนเฟิร์ม',
          'คอนเฟิร์มแล้ว',
          'เสร็จสิ้น'
        )
      )
    )
  );

COMMIT;
