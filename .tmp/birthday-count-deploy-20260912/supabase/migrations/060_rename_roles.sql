-- ============================================================
-- Migration 060: Rename roles
--   'admin'       -> 'admin-tr'
--   'order_staff'  -> 'admin-pump'
-- ============================================================

BEGIN;

-- ── 1. Update user records ──────────────────────────────────
UPDATE us_users SET role = 'admin-tr'   WHERE role = 'admin';
UPDATE us_users SET role = 'admin-pump' WHERE role = 'order_staff';

-- ── 2. Update role-menu settings ────────────────────────────
UPDATE st_user_menus SET role = 'admin-tr'   WHERE role = 'admin';
UPDATE st_user_menus SET role = 'admin-pump' WHERE role = 'order_staff';

-- ── 3. Recreate RLS policies ────────────────────────────────
-- Each section: DROP old policy, CREATE new one with renamed roles.
-- Only policies referencing 'admin' or 'order_staff' are touched.

-- ─── us_users (uses check_user_role function) ───────────────
DROP POLICY IF EXISTS "Admins can view all users" ON us_users;
DROP POLICY IF EXISTS "Admins can update users" ON us_users;

CREATE POLICY "Admins can view all users"
  ON us_users FOR SELECT
  USING (
    auth.uid() = id OR
    check_user_role(auth.uid(), ARRAY['superadmin', 'admin-tr'])
  );

CREATE POLICY "Admins can update users"
  ON us_users FOR UPDATE
  USING (
    auth.uid() = id OR
    check_user_role(auth.uid(), ARRAY['superadmin', 'admin-tr'])
  );

-- ─── fonts (uses check_user_role function) ──────────────────
DROP POLICY IF EXISTS "Allow superadmin and admin to insert fonts" ON fonts;
DROP POLICY IF EXISTS "Allow superadmin and admin to update fonts" ON fonts;

CREATE POLICY "Allow superadmin and admin to insert fonts"
  ON fonts FOR INSERT
  TO authenticated
  WITH CHECK (
    check_user_role(auth.uid(), ARRAY['superadmin', 'admin-tr'])
  );

CREATE POLICY "Allow superadmin and admin to update fonts"
  ON fonts FOR UPDATE
  TO authenticated
  USING (
    check_user_role(auth.uid(), ARRAY['superadmin', 'admin-tr'])
  );

-- ─── pr_products ────────────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage products" ON pr_products;
CREATE POLICY "Admins can manage products"
  ON pr_products FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin-pump'))
  );

-- ─── cp_cartoon_patterns ────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage patterns" ON cp_cartoon_patterns;
CREATE POLICY "Admins can manage patterns"
  ON cp_cartoon_patterns FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin-pump'))
  );

-- ─── channels ───────────────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage channels" ON channels;
CREATE POLICY "Admins can manage channels"
  ON channels FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin-pump'))
  );

-- ─── ink_types ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage ink types" ON ink_types;
CREATE POLICY "Admins can manage ink types"
  ON ink_types FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin-pump'))
  );

-- ─── or_orders ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Authorized staff can manage orders" ON or_orders;
DROP POLICY IF EXISTS "Authorized staff can update orders" ON or_orders;
DROP POLICY IF EXISTS "Authorized staff can delete orders" ON or_orders;

CREATE POLICY "Authorized staff can manage orders"
  ON or_orders FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin-pump', 'admin_qc', 'account'))
  );

CREATE POLICY "Authorized staff can update orders"
  ON or_orders FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin-pump', 'admin_qc', 'account', 'qc_staff', 'packing_staff', 'store'))
  );

CREATE POLICY "Authorized staff can delete orders"
  ON or_orders FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin-pump', 'admin_qc'))
  );

-- ─── or_order_items ─────────────────────────────────────────
DROP POLICY IF EXISTS "Authorized staff can manage order items" ON or_order_items;
CREATE POLICY "Authorized staff can manage order items"
  ON or_order_items FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin-pump', 'admin_qc', 'account'))
  );

-- ─── or_work_orders ─────────────────────────────────────────
DROP POLICY IF EXISTS "Authorized staff can manage work orders" ON or_work_orders;
CREATE POLICY "Authorized staff can manage work orders"
  ON or_work_orders FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin-pump', 'packing_staff'))
  );

-- ─── ac_verified_slips ──────────────────────────────────────
DROP POLICY IF EXISTS "Order and account staff can manage verified slips" ON ac_verified_slips;
CREATE POLICY "Order and account staff can manage verified slips"
  ON ac_verified_slips FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin-pump', 'account'))
  );

-- ─── ac_refunds ─────────────────────────────────────────────
DROP POLICY IF EXISTS "Account staff can manage refunds" ON ac_refunds;
CREATE POLICY "Account staff can manage refunds"
  ON ac_refunds FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'account'))
  );

-- ─── ac_slip_verification_logs ──────────────────────────────
DROP POLICY IF EXISTS "Order and account staff can manage slip verification logs" ON ac_slip_verification_logs;
CREATE POLICY "Order and account staff can manage slip verification logs"
  ON ac_slip_verification_logs FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin-pump', 'account_staff'))
  );

-- ─── promotion ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Admins and order staff can manage promotions" ON promotion;
CREATE POLICY "Admins and order staff can manage promotions"
  ON promotion FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin-pump'))
  );

-- ─── pk_packing_videos ──────────────────────────────────────
DROP POLICY IF EXISTS "Packing staff can manage packing videos" ON pk_packing_videos;
CREATE POLICY "Packing staff can manage packing videos"
  ON pk_packing_videos FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'packing_staff'))
  );

-- ─── wms_orders ─────────────────────────────────────────────
DROP POLICY IF EXISTS "WMS orders read" ON wms_orders;
DROP POLICY IF EXISTS "WMS orders write" ON wms_orders;

CREATE POLICY "WMS orders read"
  ON wms_orders FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'store', 'production', 'manager', 'picker'))
  );

CREATE POLICY "WMS orders write"
  ON wms_orders FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'store', 'production', 'manager', 'picker'))
  );

-- ─── wms_order_summaries ────────────────────────────────────
DROP POLICY IF EXISTS "WMS order summaries read" ON wms_order_summaries;
DROP POLICY IF EXISTS "WMS order summaries write" ON wms_order_summaries;

CREATE POLICY "WMS order summaries read"
  ON wms_order_summaries FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'store', 'manager'))
  );

CREATE POLICY "WMS order summaries write"
  ON wms_order_summaries FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'store', 'manager'))
  );

-- ─── wms_notifications ──────────────────────────────────────
DROP POLICY IF EXISTS "WMS notifications read" ON wms_notifications;
DROP POLICY IF EXISTS "WMS notifications write" ON wms_notifications;

CREATE POLICY "WMS notifications read"
  ON wms_notifications FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'store', 'manager', 'picker'))
  );

CREATE POLICY "WMS notifications write"
  ON wms_notifications FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'store', 'manager', 'picker'))
  );

-- ─── wms_notification_topics ────────────────────────────────
DROP POLICY IF EXISTS "WMS notification topics read" ON wms_notification_topics;
DROP POLICY IF EXISTS "WMS notification topics write" ON wms_notification_topics;

CREATE POLICY "WMS notification topics read"
  ON wms_notification_topics FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'store', 'production', 'manager', 'picker'))
  );

CREATE POLICY "WMS notification topics write"
  ON wms_notification_topics FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'store'))
  );

-- ─── wms_requisitions ───────────────────────────────────────
DROP POLICY IF EXISTS "WMS requisitions read" ON wms_requisitions;
DROP POLICY IF EXISTS "WMS requisitions write" ON wms_requisitions;

CREATE POLICY "WMS requisitions read"
  ON wms_requisitions FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'store', 'production', 'manager'))
  );

CREATE POLICY "WMS requisitions write"
  ON wms_requisitions FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'store', 'production', 'manager'))
  );

-- ─── wms_requisition_items ──────────────────────────────────
DROP POLICY IF EXISTS "WMS requisition items read" ON wms_requisition_items;
DROP POLICY IF EXISTS "WMS requisition items write" ON wms_requisition_items;

CREATE POLICY "WMS requisition items read"
  ON wms_requisition_items FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'store', 'production', 'manager'))
  );

CREATE POLICY "WMS requisition items write"
  ON wms_requisition_items FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'store', 'production', 'manager'))
  );

-- ─── wms_requisition_topics ─────────────────────────────────
DROP POLICY IF EXISTS "WMS requisition topics read" ON wms_requisition_topics;
DROP POLICY IF EXISTS "WMS requisition topics write" ON wms_requisition_topics;

CREATE POLICY "WMS requisition topics read"
  ON wms_requisition_topics FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'store', 'production', 'manager'))
  );

CREATE POLICY "WMS requisition topics write"
  ON wms_requisition_topics FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'store'))
  );

-- ─── or_order_chat_logs ─────────────────────────────────────
DROP POLICY IF EXISTS "Order staff can manage chat logs" ON or_order_chat_logs;
CREATE POLICY "Order staff can manage chat logs"
  ON or_order_chat_logs FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin-pump', 'admin_qc', 'account_staff'))
  );

-- ─── or_issue_types ─────────────────────────────────────────
DROP POLICY IF EXISTS "Order staff can manage issue types" ON or_issue_types;
CREATE POLICY "Order staff can manage issue types"
  ON or_issue_types FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin-pump', 'admin_qc', 'account_staff'))
  );

-- ─── or_issues ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Issue owners can view issues" ON or_issues;
DROP POLICY IF EXISTS "Issue owners can manage issues" ON or_issues;

CREATE POLICY "Issue owners can view issues"
  ON or_issues FOR SELECT
  USING (
    (EXISTS (
      SELECT 1 FROM or_orders o
      WHERE o.id = or_issues.order_id
        AND (o.admin_user = (SELECT username FROM us_users WHERE id = auth.uid())
             OR o.admin_user = (auth.jwt() ->> 'email'))
    ))
    OR EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin_qc'))
  );

CREATE POLICY "Issue owners can manage issues"
  ON or_issues FOR ALL
  USING (
    (EXISTS (
      SELECT 1 FROM or_orders o
      WHERE o.id = or_issues.order_id
        AND (o.admin_user = (SELECT username FROM us_users WHERE id = auth.uid())
             OR o.admin_user = (auth.jwt() ->> 'email'))
    ))
    OR EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin_qc'))
  );

-- ─── or_issue_messages ──────────────────────────────────────
DROP POLICY IF EXISTS "Issue owners can view messages" ON or_issue_messages;
DROP POLICY IF EXISTS "Issue owners can manage messages" ON or_issue_messages;

CREATE POLICY "Issue owners can view messages"
  ON or_issue_messages FOR SELECT
  USING (
    (EXISTS (
      SELECT 1 FROM or_issues i
      JOIN or_orders o ON o.id = i.order_id
      WHERE i.id = or_issue_messages.issue_id
        AND (o.admin_user = (SELECT username FROM us_users WHERE id = auth.uid())
             OR o.admin_user = (auth.jwt() ->> 'email'))
    ))
    OR EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin_qc'))
  );

CREATE POLICY "Issue owners can manage messages"
  ON or_issue_messages FOR ALL
  USING (
    (EXISTS (
      SELECT 1 FROM or_issues i
      JOIN or_orders o ON o.id = i.order_id
      WHERE i.id = or_issue_messages.issue_id
        AND (o.admin_user = (SELECT username FROM us_users WHERE id = auth.uid())
             OR o.admin_user = (auth.jwt() ->> 'email'))
    ))
    OR EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin_qc'))
  );

-- ─── or_issue_reads ─────────────────────────────────────────
DROP POLICY IF EXISTS "Order staff can manage issue reads" ON or_issue_reads;
CREATE POLICY "Order staff can manage issue reads"
  ON or_issue_reads FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin-pump', 'admin_qc', 'account_staff'))
  );

-- ─── or_order_chat_reads ────────────────────────────────────
DROP POLICY IF EXISTS "Users can manage own order chat reads" ON or_order_chat_reads;
CREATE POLICY "Users can manage own order chat reads"
  ON or_order_chat_reads FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin-pump', 'admin_qc', 'account_staff', 'production'))
  );

-- ─── inv_stock_balances ─────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage stock balances" ON inv_stock_balances;
CREATE POLICY "Admins can manage stock balances"
  ON inv_stock_balances FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'store', 'manager'))
  );

-- ─── inv_stock_movements ────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage stock movements" ON inv_stock_movements;
CREATE POLICY "Admins can manage stock movements"
  ON inv_stock_movements FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'store', 'manager'))
  );

-- ─── inv_pr ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage PR" ON inv_pr;
CREATE POLICY "Admins can manage PR"
  ON inv_pr FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'manager', 'store'))
  );

-- ─── inv_pr_items ───────────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage PR items" ON inv_pr_items;
CREATE POLICY "Admins can manage PR items"
  ON inv_pr_items FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'manager', 'store'))
  );

-- ─── inv_po ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage PO" ON inv_po;
CREATE POLICY "Admins can manage PO"
  ON inv_po FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'manager', 'store'))
  );

-- ─── inv_po_items ───────────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage PO items" ON inv_po_items;
CREATE POLICY "Admins can manage PO items"
  ON inv_po_items FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'manager', 'store'))
  );

-- ─── inv_gr ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage GR" ON inv_gr;
CREATE POLICY "Admins can manage GR"
  ON inv_gr FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'manager', 'store'))
  );

-- ─── inv_gr_items ───────────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage GR items" ON inv_gr_items;
CREATE POLICY "Admins can manage GR items"
  ON inv_gr_items FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'manager', 'store'))
  );

-- ─── inv_audits ─────────────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage audits" ON inv_audits;
CREATE POLICY "Admins can manage audits"
  ON inv_audits FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'manager', 'store'))
  );

-- ─── inv_audit_items ────────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage audit items" ON inv_audit_items;
CREATE POLICY "Admins can manage audit items"
  ON inv_audit_items FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'manager', 'store'))
  );

-- ─── inv_adjustments ────────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage adjustments" ON inv_adjustments;
CREATE POLICY "Admins can manage adjustments"
  ON inv_adjustments FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'manager', 'store'))
  );

-- ─── inv_adjustment_items ───────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage adjustment items" ON inv_adjustment_items;
CREATE POLICY "Admins can manage adjustment items"
  ON inv_adjustment_items FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'manager', 'store'))
  );

-- ─── inv_returns ────────────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage returns" ON inv_returns;
CREATE POLICY "Admins can manage returns"
  ON inv_returns FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'manager', 'store'))
  );

-- ─── inv_return_items ───────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage return items" ON inv_return_items;
CREATE POLICY "Admins can manage return items"
  ON inv_return_items FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'manager', 'store'))
  );

-- ─── ac_bill_edit_logs ──────────────────────────────────────
DROP POLICY IF EXISTS "ac_bill_edit_logs read" ON ac_bill_edit_logs;
DROP POLICY IF EXISTS "ac_bill_edit_logs write" ON ac_bill_edit_logs;

CREATE POLICY "ac_bill_edit_logs read"
  ON ac_bill_edit_logs FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'account'))
  );

CREATE POLICY "ac_bill_edit_logs write"
  ON ac_bill_edit_logs FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'account'))
  );

-- ─── ac_manual_slip_checks ──────────────────────────────────
DROP POLICY IF EXISTS "ac_manual_slip_checks read" ON ac_manual_slip_checks;
DROP POLICY IF EXISTS "ac_manual_slip_checks write" ON ac_manual_slip_checks;

CREATE POLICY "ac_manual_slip_checks read"
  ON ac_manual_slip_checks FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'account'))
  );

CREATE POLICY "ac_manual_slip_checks write"
  ON ac_manual_slip_checks FOR ALL
  USING (
    EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'account'))
  );

COMMIT;
