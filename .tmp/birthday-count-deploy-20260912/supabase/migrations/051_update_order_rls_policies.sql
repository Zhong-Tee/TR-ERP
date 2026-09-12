-- ============================================
-- อัปเดต RLS Policies สำหรับ or_orders, or_order_items, or_work_orders, ac_verified_slips, ac_refunds
-- แก้ไข: account_staff → account, เพิ่ม role ใหม่ (production, production_mb, store, manager, picker, viewer)
-- ============================================

-- ====== or_orders ======
DROP POLICY IF EXISTS "Order staff can view and manage orders" ON or_orders;
DROP POLICY IF EXISTS "QC staff can view orders" ON or_orders;

-- ทุก role ที่ authenticated สามารถดูรายการบิลได้
CREATE POLICY "Authenticated users can view orders"
  ON or_orders FOR SELECT
  USING (auth.role() = 'authenticated');

-- เฉพาะ role ที่มีสิทธิ์แก้ไขเท่านั้นที่ INSERT/UPDATE/DELETE ได้
CREATE POLICY "Authorized staff can manage orders"
  ON or_orders FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff', 'admin_qc', 'account')
    )
  );

CREATE POLICY "Authorized staff can update orders"
  ON or_orders FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff', 'admin_qc', 'account', 'qc_staff', 'packing_staff', 'store')
    )
  );

CREATE POLICY "Authorized staff can delete orders"
  ON or_orders FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff', 'admin_qc')
    )
  );

-- ====== or_order_items ======
DROP POLICY IF EXISTS "Order staff can manage order items" ON or_order_items;
DROP POLICY IF EXISTS "QC and packing staff can view order items" ON or_order_items;

CREATE POLICY "Authenticated users can view order items"
  ON or_order_items FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Authorized staff can manage order items"
  ON or_order_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff', 'admin_qc', 'account')
    )
  );

-- ====== or_work_orders ======
DROP POLICY IF EXISTS "Order staff can manage work orders" ON or_work_orders;
DROP POLICY IF EXISTS "QC staff can view work orders" ON or_work_orders;

CREATE POLICY "Authenticated users can view work orders"
  ON or_work_orders FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Authorized staff can manage work orders"
  ON or_work_orders FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff', 'packing_staff')
    )
  );

-- ====== ac_verified_slips ======
DROP POLICY IF EXISTS "Order and account staff can manage verified slips" ON ac_verified_slips;

CREATE POLICY "Order and account staff can manage verified slips"
  ON ac_verified_slips FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'order_staff', 'account')
    )
  );

-- ====== ac_refunds ======
DROP POLICY IF EXISTS "Account staff can manage refunds" ON ac_refunds;

CREATE POLICY "Account staff can manage refunds"
  ON ac_refunds FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'account')
    )
  );
