-- =====================================================================
-- Fix WMS RLS: เปลี่ยน admin-tr → admin ในทุกตาราง WMS
-- และเพิ่ม admin ใน us_users SELECT policy
-- =====================================================================

-- ─── wms_orders ─────────────────────────────────────────────
DROP POLICY IF EXISTS "WMS orders read" ON wms_orders;
DROP POLICY IF EXISTS "WMS orders write" ON wms_orders;

CREATE POLICY "WMS orders read"
  ON wms_orders FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store','production','manager','picker'))
  );

CREATE POLICY "WMS orders write"
  ON wms_orders FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store','production','manager','picker'))
  );

-- ─── wms_order_summaries ────────────────────────────────────
DROP POLICY IF EXISTS "WMS order summaries read" ON wms_order_summaries;
DROP POLICY IF EXISTS "WMS order summaries write" ON wms_order_summaries;

CREATE POLICY "WMS order summaries read"
  ON wms_order_summaries FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store','manager'))
  );

CREATE POLICY "WMS order summaries write"
  ON wms_order_summaries FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store','manager'))
  );

-- ─── wms_notifications ─────────────────────────────────────
DROP POLICY IF EXISTS "WMS notifications read" ON wms_notifications;
DROP POLICY IF EXISTS "WMS notifications write" ON wms_notifications;

CREATE POLICY "WMS notifications read"
  ON wms_notifications FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store','manager','picker'))
  );

CREATE POLICY "WMS notifications write"
  ON wms_notifications FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store','manager','picker'))
  );

-- ─── wms_notification_topics ────────────────────────────────
DROP POLICY IF EXISTS "WMS notification topics read" ON wms_notification_topics;
DROP POLICY IF EXISTS "WMS notification topics write" ON wms_notification_topics;

CREATE POLICY "WMS notification topics read"
  ON wms_notification_topics FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store','production','manager','production_mb'))
  );

CREATE POLICY "WMS notification topics write"
  ON wms_notification_topics FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store'))
  );

-- ─── wms_return_requisitions: ลบ admin-tr ออก ───────────────
DROP POLICY IF EXISTS "Anyone authenticated can view return requisitions" ON wms_return_requisitions;
DROP POLICY IF EXISTS "Production and admins can create return requisitions" ON wms_return_requisitions;
DROP POLICY IF EXISTS "Admins can manage return requisitions" ON wms_return_requisitions;
DROP POLICY IF EXISTS "Admins can delete return requisitions" ON wms_return_requisitions;

CREATE POLICY "Anyone authenticated can view return requisitions"
  ON wms_return_requisitions FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Production and admins can create return requisitions"
  ON wms_return_requisitions FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store','manager','production','production_mb'))
  );

CREATE POLICY "Admins can manage return requisitions"
  ON wms_return_requisitions FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store','manager','production'))
  );

CREATE POLICY "Admins can delete return requisitions"
  ON wms_return_requisitions FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store','manager'))
  );

-- ─── wms_return_requisition_items: ลบ admin-tr ออก ──────────
DROP POLICY IF EXISTS "Anyone authenticated can view return requisition items" ON wms_return_requisition_items;
DROP POLICY IF EXISTS "Production and admins can create return requisition items" ON wms_return_requisition_items;
DROP POLICY IF EXISTS "Admins can manage return requisition items" ON wms_return_requisition_items;

CREATE POLICY "Anyone authenticated can view return requisition items"
  ON wms_return_requisition_items FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Production and admins can create return requisition items"
  ON wms_return_requisition_items FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store','manager','production','production_mb'))
  );

CREATE POLICY "Admins can manage return requisition items"
  ON wms_return_requisition_items FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','store','manager'))
  );

-- ─── inv_stock_balances: เพิ่ม admin ──────────────────────────
DROP POLICY IF EXISTS "Admins can manage stock balances" ON inv_stock_balances;

CREATE POLICY "Admins can manage stock balances"
  ON inv_stock_balances FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','admin-tr','store','manager','production'))
  );

-- ─── inv_stock_movements: เพิ่ม admin ─────────────────────────
DROP POLICY IF EXISTS "Admins can manage stock movements" ON inv_stock_movements;

CREATE POLICY "Admins can manage stock movements"
  ON inv_stock_movements FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid()
      AND role IN ('superadmin','admin','admin-tr','store','manager','production'))
  );

-- ─── us_users: เพิ่ม admin ใน SELECT policy ─────────────────
DROP POLICY IF EXISTS "Admins can view all users" ON us_users;

CREATE POLICY "Admins can view all users"
  ON us_users FOR SELECT
  USING (
    auth.uid() = id OR
    check_user_role(auth.uid(), ARRAY['superadmin','admin','admin-tr','manager'])
  );
