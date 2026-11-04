-- =====================================================================
-- Migration 139: admin_qc -> qc_order compatibility
-- รองรับ role เก่า+ใหม่พร้อมกันชั่วคราวใน RLS/policies สำคัญ
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1) Orders / Order items / Order reviews
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Authorized staff can insert orders" ON or_orders;
DROP POLICY IF EXISTS "Authorized staff can update orders" ON or_orders;
DROP POLICY IF EXISTS "Authorized staff can delete orders" ON or_orders;

CREATE POLICY "Authorized staff can insert orders"
  ON or_orders FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'admin_qc', 'qc_order', 'account')
    )
  );

CREATE POLICY "Authorized staff can update orders"
  ON or_orders FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'admin_qc', 'qc_order', 'account', 'qc_staff', 'packing_staff', 'store')
    )
  );

CREATE POLICY "Authorized staff can delete orders"
  ON or_orders FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'admin_qc', 'qc_order')
    )
  );

DROP POLICY IF EXISTS "Authorized staff can insert order items" ON or_order_items;
DROP POLICY IF EXISTS "Authorized staff can update order items" ON or_order_items;
DROP POLICY IF EXISTS "Authorized staff can delete order items" ON or_order_items;

CREATE POLICY "Authorized staff can insert order items"
  ON or_order_items FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'admin_qc', 'qc_order', 'account')
    )
  );

CREATE POLICY "Authorized staff can update order items"
  ON or_order_items FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'admin_qc', 'qc_order', 'account')
    )
  );

CREATE POLICY "Authorized staff can delete order items"
  ON or_order_items FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'admin_qc', 'qc_order', 'account')
    )
  );

DROP POLICY IF EXISTS "Admin QC can manage reviews" ON or_order_reviews;
CREATE POLICY "Admin QC can manage reviews"
  ON or_order_reviews FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'admin_qc', 'qc_order')
    )
  );

-- ---------------------------------------------------------------------
-- 2) Issue / chat policies
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Order staff can manage chat logs" ON or_order_chat_logs;
CREATE POLICY "Order staff can manage chat logs"
  ON or_order_chat_logs FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'admin_qc', 'qc_order', 'account')
    )
  );

DROP POLICY IF EXISTS "Order staff can manage issue types" ON or_issue_types;
CREATE POLICY "Order staff can manage issue types"
  ON or_issue_types FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'admin_qc', 'qc_order', 'account')
    )
  );

DROP POLICY IF EXISTS "Issue owners can view issues" ON or_issues;
DROP POLICY IF EXISTS "Issue owners can manage issues" ON or_issues;

CREATE POLICY "Issue owners can view issues"
  ON or_issues FOR SELECT
  USING (
    (
      EXISTS (
        SELECT 1
        FROM or_orders o
        WHERE o.id = or_issues.order_id
          AND (
            o.admin_user = (SELECT username FROM us_users WHERE id = auth.uid())
            OR o.admin_user = (auth.jwt() ->> 'email')
          )
      )
    )
    OR EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'admin_qc', 'qc_order')
    )
  );

CREATE POLICY "Issue owners can manage issues"
  ON or_issues FOR ALL
  USING (
    (
      EXISTS (
        SELECT 1
        FROM or_orders o
        WHERE o.id = or_issues.order_id
          AND (
            o.admin_user = (SELECT username FROM us_users WHERE id = auth.uid())
            OR o.admin_user = (auth.jwt() ->> 'email')
          )
      )
    )
    OR EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'admin_qc', 'qc_order')
    )
  );

DROP POLICY IF EXISTS "Issue owners can view messages" ON or_issue_messages;
DROP POLICY IF EXISTS "Issue owners can manage messages" ON or_issue_messages;

CREATE POLICY "Issue owners can view messages"
  ON or_issue_messages FOR SELECT
  USING (
    (
      EXISTS (
        SELECT 1
        FROM or_issues i
        JOIN or_orders o ON o.id = i.order_id
        WHERE i.id = or_issue_messages.issue_id
          AND (
            o.admin_user = (SELECT username FROM us_users WHERE id = auth.uid())
            OR o.admin_user = (auth.jwt() ->> 'email')
          )
      )
    )
    OR EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'admin_qc', 'qc_order')
    )
  );

CREATE POLICY "Issue owners can manage messages"
  ON or_issue_messages FOR ALL
  USING (
    (
      EXISTS (
        SELECT 1
        FROM or_issues i
        JOIN or_orders o ON o.id = i.order_id
        WHERE i.id = or_issue_messages.issue_id
          AND (
            o.admin_user = (SELECT username FROM us_users WHERE id = auth.uid())
            OR o.admin_user = (auth.jwt() ->> 'email')
          )
      )
    )
    OR EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'admin_qc', 'qc_order')
    )
  );

DROP POLICY IF EXISTS "Order staff can manage issue reads" ON or_issue_reads;
CREATE POLICY "Order staff can manage issue reads"
  ON or_issue_reads FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'admin_qc', 'qc_order', 'account')
    )
  );

DROP POLICY IF EXISTS "Users can manage own order chat reads" ON or_order_chat_reads;
CREATE POLICY "Users can manage own order chat reads"
  ON or_order_chat_reads FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'admin_qc', 'qc_order', 'account', 'production')
    )
  );

-- ---------------------------------------------------------------------
-- 3) Product config + QC checklist + QC skip logs
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can manage category field settings" ON pr_category_field_settings;
CREATE POLICY "Admins can manage category field settings"
  ON pr_category_field_settings FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'admin_qc', 'qc_order')
    )
  );

DROP POLICY IF EXISTS "Admins can manage product field overrides" ON pr_product_field_overrides;
CREATE POLICY "Admins can manage product field overrides"
  ON pr_product_field_overrides FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'admin_qc', 'qc_order')
    )
  );

DROP POLICY IF EXISTS "Admin and QC staff can manage checklist topics" ON qc_checklist_topics;
CREATE POLICY "Admin and QC staff can manage checklist topics"
  ON qc_checklist_topics FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'admin_qc', 'qc_order', 'qc_staff')
    )
  );

DROP POLICY IF EXISTS "Admin and QC staff can manage checklist items" ON qc_checklist_items;
CREATE POLICY "Admin and QC staff can manage checklist items"
  ON qc_checklist_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'admin_qc', 'qc_order', 'qc_staff')
    )
  );

DROP POLICY IF EXISTS "Admin and QC staff can manage checklist topic products" ON qc_checklist_topic_products;
CREATE POLICY "Admin and QC staff can manage checklist topic products"
  ON qc_checklist_topic_products FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'sales-tr', 'admin_qc', 'qc_order', 'qc_staff')
    )
  );

DROP POLICY IF EXISTS "qc_skip_logs_write" ON qc_skip_logs;
CREATE POLICY "qc_skip_logs_write"
  ON qc_skip_logs FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'sales-tr', 'admin_qc', 'qc_order', 'qc_staff')
    )
  );

COMMIT;
