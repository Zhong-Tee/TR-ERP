-- =====================================================================
-- Migration 136: Sales role compatibility window
-- รองรับ role ใหม่ sales-tr / sales-pump ควบคู่ role เดิม admin-tr / admin-pump
-- โดยยังไม่บังคับย้ายข้อมูล role ทั้งระบบใน migration นี้
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1) us_users admin policies: เพิ่ม sales-tr ให้สิทธิ์เทียบ admin-tr
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can view all users" ON us_users;
CREATE POLICY "Admins can view all users"
  ON us_users FOR SELECT
  USING (
    auth.uid() = id OR
    check_user_role(auth.uid(), ARRAY['superadmin', 'admin-tr', 'sales-tr'])
  );

DROP POLICY IF EXISTS "Admins update any user" ON us_users;
CREATE POLICY "Admins update any user"
  ON us_users FOR UPDATE
  USING (
    check_user_role(auth.uid(), ARRAY['superadmin', 'admin-tr', 'sales-tr'])
  );

-- ---------------------------------------------------------------------
-- 2) Orders RLS: เพิ่ม sales-tr / sales-pump ให้ครอบ flow ออเดอร์หลัก
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Authorized staff can manage orders" ON or_orders;
DROP POLICY IF EXISTS "Authorized staff can update orders" ON or_orders;
DROP POLICY IF EXISTS "Authorized staff can delete orders" ON or_orders;

CREATE POLICY "Authorized staff can manage orders"
  ON or_orders FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'admin-pump', 'sales-pump', 'admin_qc', 'account')
    )
  );

CREATE POLICY "Authorized staff can update orders"
  ON or_orders FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'admin-pump', 'sales-pump', 'admin_qc', 'account', 'qc_staff', 'packing_staff', 'store')
    )
  );

CREATE POLICY "Authorized staff can delete orders"
  ON or_orders FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'admin-pump', 'sales-pump', 'admin_qc')
    )
  );

DROP POLICY IF EXISTS "Authorized staff can manage order items" ON or_order_items;
CREATE POLICY "Authorized staff can manage order items"
  ON or_order_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'admin-pump', 'sales-pump', 'admin_qc', 'account')
    )
  );

DROP POLICY IF EXISTS "Authorized staff can manage work orders" ON or_work_orders;
CREATE POLICY "Authorized staff can manage work orders"
  ON or_work_orders FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'admin-tr', 'sales-tr', 'admin-pump', 'sales-pump', 'packing_staff')
    )
  );

-- ---------------------------------------------------------------------
-- 3) RPC Sidebar counts: owner role รองรับชื่อใหม่
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_sidebar_counts(
  p_username TEXT DEFAULT '',
  p_role TEXT DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_orders_pending bigint;
  v_admin_qc bigint;
  v_qc_reject bigint;
  v_packing bigint;
  v_warehouse bigint;
  v_refund_pending bigint;
  v_tax_pending bigint;
  v_cash_pending bigint;
  v_excluded text[] := ARRAY['รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน'];
  v_is_owner boolean;
BEGIN
  v_is_owner := (p_role IN ('admin-tr', 'sales-tr', 'admin-pump', 'sales-pump') AND p_username <> '');

  IF v_is_owner THEN
    SELECT count(*) INTO v_orders_pending
    FROM or_orders WHERE status = ANY(v_excluded) AND admin_user = p_username;
  ELSE
    SELECT count(*) INTO v_orders_pending
    FROM or_orders WHERE status = ANY(v_excluded);
  END IF;

  IF v_is_owner THEN
    SELECT count(*) INTO v_admin_qc
    FROM or_orders
    WHERE status = 'ตรวจสอบแล้ว'
      AND channel_code IS DISTINCT FROM 'PUMP'
      AND admin_user = p_username;
  ELSIF p_role IN ('superadmin', 'admin') THEN
    SELECT count(*) INTO v_admin_qc
    FROM or_orders
    WHERE status = 'ตรวจสอบแล้ว'
      AND channel_code IS DISTINCT FROM 'PUMP';
  ELSE
    SELECT count(*) INTO v_admin_qc
    FROM or_orders
    WHERE status = 'ตรวจสอบแล้ว'
      AND channel_code IS DISTINCT FROM 'PUMP'
      AND channel_code IS DISTINCT FROM 'OFFICE';
  END IF;

  SELECT count(*) INTO v_qc_reject
  FROM qc_records WHERE is_rejected = true;

  SELECT count(*) INTO v_packing
  FROM or_work_orders WHERE status = 'กำลังผลิต';

  SELECT count(*) INTO v_warehouse
  FROM pr_products p
  LEFT JOIN inv_stock_balances b ON b.product_id = p.id
  WHERE p.is_active = true
    AND p.order_point IS NOT NULL
    AND NULLIF(TRIM(REPLACE(p.order_point::text, ',', '')), '') IS NOT NULL
    AND NULLIF(TRIM(REPLACE(p.order_point::text, ',', '')), '')::numeric > 0
    AND COALESCE(b.on_hand, 0) < NULLIF(TRIM(REPLACE(p.order_point::text, ',', '')), '')::numeric;

  IF v_is_owner THEN
    SELECT count(*) INTO v_refund_pending
    FROM ac_refunds r
    JOIN or_orders o ON o.id = r.order_id
    WHERE r.status = 'pending'
      AND r.reason LIKE '%โอนเกิน%'
      AND o.status = 'จัดส่งแล้ว'
      AND o.admin_user = p_username;
  ELSE
    SELECT count(*) INTO v_refund_pending
    FROM ac_refunds r
    JOIN or_orders o ON o.id = r.order_id
    WHERE r.status = 'pending'
      AND r.reason LIKE '%โอนเกิน%'
      AND o.status = 'จัดส่งแล้ว';
  END IF;

  IF v_is_owner THEN
    SELECT count(*) INTO v_tax_pending
    FROM or_orders
    WHERE billing_details @> '{"request_tax_invoice": true}'::jsonb
      AND NOT COALESCE(billing_details @> '{"account_confirmed_tax": true}'::jsonb, false)
      AND status != ALL(v_excluded)
      AND admin_user = p_username;
  ELSE
    SELECT count(*) INTO v_tax_pending
    FROM or_orders
    WHERE billing_details @> '{"request_tax_invoice": true}'::jsonb
      AND NOT COALESCE(billing_details @> '{"account_confirmed_tax": true}'::jsonb, false)
      AND status != ALL(v_excluded);
  END IF;

  IF v_is_owner THEN
    SELECT count(*) INTO v_cash_pending
    FROM or_orders
    WHERE billing_details @> '{"request_cash_bill": true}'::jsonb
      AND NOT COALESCE(billing_details @> '{"account_confirmed_cash": true}'::jsonb, false)
      AND status != ALL(v_excluded)
      AND admin_user = p_username;
  ELSE
    SELECT count(*) INTO v_cash_pending
    FROM or_orders
    WHERE billing_details @> '{"request_cash_bill": true}'::jsonb
      AND NOT COALESCE(billing_details @> '{"account_confirmed_cash": true}'::jsonb, false)
      AND status != ALL(v_excluded);
  END IF;

  RETURN jsonb_build_object(
    'orders', v_orders_pending,
    'admin_qc', v_admin_qc,
    'qc_reject', v_qc_reject,
    'packing', v_packing,
    'warehouse', v_warehouse,
    'refund_pending', v_refund_pending,
    'tax_pending', v_tax_pending,
    'cash_pending', v_cash_pending
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_sidebar_counts(TEXT, TEXT) TO authenticated;

-- ---------------------------------------------------------------------
-- 4) RPC unread chat: owner role รองรับชื่อใหม่
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_unread_chat_count(
  p_user_id UUID,
  p_role TEXT,
  p_username TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_issue_on_count bigint;
  v_issue_unread bigint := 0;
  v_order_unread bigint := 0;
  v_is_admin boolean;
  v_is_owner boolean;
  v_is_production boolean;
BEGIN
  SELECT count(*) INTO v_issue_on_count
  FROM or_issues WHERE status = 'On';

  v_is_admin := p_role IN ('superadmin', 'admin');
  v_is_owner := p_role IN ('admin-tr', 'sales-tr', 'admin-pump', 'sales-pump');
  v_is_production := p_role = 'production';

  IF v_is_admin THEN
    SELECT count(*) INTO v_issue_unread
    FROM or_issue_messages m
    LEFT JOIN or_issue_reads r ON r.issue_id = m.issue_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);
  ELSIF v_is_owner THEN
    SELECT count(*) INTO v_issue_unread
    FROM or_issue_messages m
    JOIN or_issues i ON i.id = m.issue_id
    JOIN or_orders o ON o.id = i.order_id
    LEFT JOIN or_issue_reads r ON r.issue_id = m.issue_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND o.admin_user = p_username
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);
  ELSIF v_is_production THEN
    SELECT count(*) INTO v_issue_unread
    FROM or_issue_messages m
    JOIN or_issues i ON i.id = m.issue_id
    LEFT JOIN or_orders o ON o.id = i.order_id
    LEFT JOIN or_issue_reads r ON r.issue_id = m.issue_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND (i.created_by = p_user_id OR o.admin_user = p_username)
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);
  END IF;

  IF v_is_admin THEN
    SELECT count(*) INTO v_order_unread
    FROM or_order_chat_logs m
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);
  ELSIF v_is_owner THEN
    SELECT count(*) INTO v_order_unread
    FROM or_order_chat_logs m
    JOIN or_orders o ON o.id = m.order_id
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND o.admin_user = p_username
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz);
  ELSIF v_is_production THEN
    SELECT count(*) INTO v_order_unread
    FROM or_order_chat_logs m
    LEFT JOIN or_order_chat_reads r ON r.order_id = m.order_id AND r.user_id = p_user_id
    WHERE COALESCE(m.is_hidden, false) = false
      AND m.created_at > COALESCE(r.last_read_at, '1970-01-01'::timestamptz)
      AND (
        m.order_id IN (SELECT id FROM or_orders WHERE admin_user = p_username)
        OR m.order_id IN (SELECT order_id FROM or_issues WHERE created_by = p_user_id)
      );
  END IF;

  RETURN jsonb_build_object(
    'issue_on_count', v_issue_on_count,
    'issue_unread', v_issue_unread,
    'order_unread', v_order_unread
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_unread_chat_count(UUID, TEXT, TEXT) TO authenticated;

COMMIT;

