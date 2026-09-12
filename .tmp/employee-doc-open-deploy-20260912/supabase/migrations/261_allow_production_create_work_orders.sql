-- =====================================================================
-- Migration 261: ให้ role production สร้างใบงานได้ (Plan -> ใบสั่งงาน)
-- ปัญหา: production กด "สร้างใบงาน" แล้วเจอ
--   "new row violates row-level security policy for table or_work_orders"
-- สาเหตุ: flow การสร้างใบงานเขียน 3 ตาราง แต่ production ขาดสิทธิ์ 2 จุด
--   1) or_work_orders INSERT  (จุดที่ error) — ยังไม่มี production
--   2) or_orders UPDATE (ผูก work_order_id/สถานะบิล) — ยังไม่มี production
--   3) plan_jobs INSERT — production มีสิทธิ์อยู่แล้ว (migration 223)
-- แก้: เพิ่ม production เข้า policy ข้อ 1 และ 2
-- =====================================================================

BEGIN;

-- ─── or_work_orders: อนุญาตให้ production insert ใบงาน ──────────────────
DROP POLICY IF EXISTS "Authorized staff can insert work orders" ON or_work_orders;
CREATE POLICY "Authorized staff can insert work orders"
  ON or_work_orders FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'packing_staff', 'production')
    )
  );

-- ─── or_orders: อนุญาตให้ production update บิล (ผูกเข้าใบงาน) ───────────
DROP POLICY IF EXISTS "Authorized staff can update orders" ON or_orders;
CREATE POLICY "Authorized staff can update orders"
  ON or_orders FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'admin_qc', 'account', 'qc_staff', 'packing_staff', 'store', 'production')
    )
  );

COMMIT;
