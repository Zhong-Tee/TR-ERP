-- Align get_sidebar_counts.warehouse with Warehouse.tsx isBelowReorderThreshold:
-- - exclude hold
-- - include pending PO in qty threshold
-- - include order_point_days using avg daily sales (default 14 days lookback)

BEGIN;

CREATE OR REPLACE FUNCTION get_sidebar_counts(
  p_username TEXT DEFAULT '',
  p_role TEXT DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_orders_pending bigint;
  v_orders_req_claim_shipping bigint;
  v_admin_qc bigint;
  v_qc_reject bigint;
  v_packing bigint;
  v_warehouse bigint;
  v_refund_pending bigint;
  v_tax_pending bigint;
  v_cash_pending bigint;
  v_manual_slip_pending bigint;
  v_amendment_pending bigint;
  v_claim_pending bigint;
  v_excluded text[] := ARRAY['รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน'];
  v_is_sales_pump_owner boolean;
  v_is_sales_tr_team boolean;
  v_sales_from date;
  v_sales_days numeric;
BEGIN
  v_is_sales_pump_owner := (p_role = 'sales-pump' AND p_username <> '');
  v_is_sales_tr_team := (p_role = 'sales-tr');

  -- Warehouse.tsx default: salesFromDate = today - 14 days
  v_sales_from := (CURRENT_DATE - 14);
  -- calendarDaysFromFilterToToday() in UI is inclusive-ish; keep it stable and non-zero
  v_sales_days := GREATEST((CURRENT_DATE - v_sales_from), 1);

  IF v_is_sales_pump_owner THEN
    SELECT count(*) INTO v_orders_pending
    FROM or_orders WHERE status = ANY(v_excluded) AND admin_user = p_username;
  ELSIF v_is_sales_tr_team THEN
    SELECT count(*) INTO v_orders_pending
    FROM or_orders
    WHERE status = ANY(v_excluded)
      AND admin_user IN (
        SELECT DISTINCT TRIM(u.username) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.username IS NOT NULL AND TRIM(u.username) <> ''
        UNION
        SELECT DISTINCT TRIM(u.email) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.email IS NOT NULL AND TRIM(u.email) <> ''
      );
  ELSE
    SELECT count(*) INTO v_orders_pending
    FROM or_orders WHERE status = ANY(v_excluded);
  END IF;

  IF v_is_sales_pump_owner THEN
    SELECT count(*) INTO v_orders_req_claim_shipping
    FROM or_orders o
    WHERE o.bill_no LIKE 'REQ%'
      AND o.claim_shipping_confirmed_at IS NULL
      AND o.status IS DISTINCT FROM 'ยกเลิก'
      AND o.admin_user = p_username;
  ELSIF v_is_sales_tr_team THEN
    SELECT count(*) INTO v_orders_req_claim_shipping
    FROM or_orders o
    WHERE o.bill_no LIKE 'REQ%'
      AND o.claim_shipping_confirmed_at IS NULL
      AND o.status IS DISTINCT FROM 'ยกเลิก'
      AND o.admin_user IN (
        SELECT DISTINCT TRIM(u.username) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.username IS NOT NULL AND TRIM(u.username) <> ''
        UNION
        SELECT DISTINCT TRIM(u.email) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.email IS NOT NULL AND TRIM(u.email) <> ''
      );
  ELSE
    SELECT count(*) INTO v_orders_req_claim_shipping
    FROM or_orders o
    WHERE o.bill_no LIKE 'REQ%'
      AND o.claim_shipping_confirmed_at IS NULL
      AND o.status IS DISTINCT FROM 'ยกเลิก';
  END IF;

  IF v_is_sales_pump_owner THEN
    SELECT count(*) INTO v_admin_qc
    FROM or_orders
    WHERE status = 'รอตรวจคำสั่งซื้อ'
      AND channel_code IS DISTINCT FROM 'PUMP'
      AND admin_user = p_username;
  ELSIF v_is_sales_tr_team THEN
    SELECT count(*) INTO v_admin_qc
    FROM or_orders
    WHERE status = 'รอตรวจคำสั่งซื้อ'
      AND channel_code IS DISTINCT FROM 'PUMP'
      AND admin_user IN (
        SELECT DISTINCT TRIM(u.username) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.username IS NOT NULL AND TRIM(u.username) <> ''
        UNION
        SELECT DISTINCT TRIM(u.email) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.email IS NOT NULL AND TRIM(u.email) <> ''
      );
  ELSIF p_role IN ('superadmin', 'admin') THEN
    SELECT count(*) INTO v_admin_qc
    FROM or_orders
    WHERE status = 'รอตรวจคำสั่งซื้อ'
      AND channel_code IS DISTINCT FROM 'PUMP';
  ELSE
    SELECT count(*) INTO v_admin_qc
    FROM or_orders
    WHERE status = 'รอตรวจคำสั่งซื้อ'
      AND channel_code IS DISTINCT FROM 'PUMP'
      AND channel_code IS DISTINCT FROM 'OFFICE';
  END IF;

  SELECT count(*) INTO v_qc_reject
  FROM qc_records r
  WHERE r.is_rejected = true
    AND (
      NOT EXISTS (
        SELECT 1 FROM or_order_items oi WHERE oi.item_uid = r.item_uid
      )
      OR EXISTS (
        SELECT 1
        FROM or_order_items oi
        INNER JOIN or_orders o ON o.id = oi.order_id
        WHERE oi.item_uid = r.item_uid
          AND o.status IS DISTINCT FROM 'ยกเลิก'
      )
    );

  SELECT count(*) INTO v_packing
  FROM or_work_orders WHERE status = 'กำลังผลิต';

  -- Warehouse menu count: align with Warehouse.tsx isBelowReorderThreshold()
  -- byQty: (on_hand + pending_po) < order_point
  -- byDays: daysRemaining (round(on_hand / avgDailySales)) < order_point_days
  WITH pending_po AS (
    SELECT
      poi.product_id,
      SUM(
        GREATEST(
          COALESCE(poi.qty, 0)
          - COALESCE(poi.qty_received_total, 0)
          - COALESCE(poi.resolution_qty, 0),
          0
        )
      )::numeric AS pending_qty
    FROM inv_po_items poi
    JOIN inv_po po ON po.id = poi.po_id
    WHERE po.status IN ('ordered', 'partial')
    GROUP BY poi.product_id
  ),
  sales AS (
    SELECT
      oi.product_id,
      SUM(oi.quantity)::numeric AS total_sold
    FROM or_order_items oi
    JOIN or_orders o ON o.id = oi.order_id
    WHERE o.entry_date >= v_sales_from
      AND o.status IS DISTINCT FROM 'ยกเลิก'
      AND oi.product_id IS NOT NULL
    GROUP BY oi.product_id
  )
  SELECT count(*) INTO v_warehouse
  FROM pr_products p
  LEFT JOIN inv_stock_balances b ON b.product_id = p.id
  LEFT JOIN pending_po pp ON pp.product_id = p.id
  LEFT JOIN sales s ON s.product_id = p.id
  WHERE p.is_active = true
    AND COALESCE(p.is_hold, false) = false
    AND p.order_point IS NOT NULL
    AND NULLIF(TRIM(REPLACE(p.order_point::text, ',', '')), '') IS NOT NULL
    AND NULLIF(TRIM(REPLACE(p.order_point::text, ',', '')), '')::numeric > 0
    AND (
      -- byQty: availableSoon < order_point
      (COALESCE(b.on_hand, 0)::numeric + COALESCE(pp.pending_qty, 0)) < NULLIF(TRIM(REPLACE(p.order_point::text, ',', '')), '')::numeric
      OR
      -- byDays: daysRemaining < order_point_days (requires avg daily sales > 0)
      (
        p.order_point_days IS NOT NULL
        AND COALESCE(p.order_point_days, 0)::numeric > 0
        AND COALESCE(s.total_sold, 0) > 0
        AND (
          ROUND(
            COALESCE(b.on_hand, 0)::numeric
            /
            NULLIF((COALESCE(s.total_sold, 0) / v_sales_days), 0)
          )
        ) < COALESCE(p.order_point_days, 0)::numeric
      )
    );

  IF v_is_sales_pump_owner THEN
    SELECT count(*) INTO v_refund_pending
    FROM ac_refunds r
    JOIN or_orders o ON o.id = r.order_id
    WHERE r.status = 'pending'
      AND r.reason LIKE '%โอนเกิน%'
      AND o.status IS DISTINCT FROM 'ยกเลิก'
      AND o.admin_user = p_username;
  ELSIF v_is_sales_tr_team THEN
    SELECT count(*) INTO v_refund_pending
    FROM ac_refunds r
    JOIN or_orders o ON o.id = r.order_id
    WHERE r.status = 'pending'
      AND r.reason LIKE '%โอนเกิน%'
      AND o.status IS DISTINCT FROM 'ยกเลิก'
      AND o.admin_user IN (
        SELECT DISTINCT TRIM(u.username) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.username IS NOT NULL AND TRIM(u.username) <> ''
        UNION
        SELECT DISTINCT TRIM(u.email) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.email IS NOT NULL AND TRIM(u.email) <> ''
      );
  ELSE
    SELECT count(*) INTO v_refund_pending
    FROM ac_refunds r
    JOIN or_orders o ON o.id = r.order_id
    WHERE r.status = 'pending'
      AND r.reason LIKE '%โอนเกิน%'
      AND o.status IS DISTINCT FROM 'ยกเลิก';
  END IF;

  IF v_is_sales_pump_owner THEN
    SELECT count(*) INTO v_tax_pending
    FROM or_orders
    WHERE billing_details @> '{"request_tax_invoice": true}'::jsonb
      AND NOT COALESCE(billing_details @> '{"account_confirmed_tax": true}'::jsonb, false)
      AND status != ALL(v_excluded)
      AND admin_user = p_username;
  ELSIF v_is_sales_tr_team THEN
    SELECT count(*) INTO v_tax_pending
    FROM or_orders
    WHERE billing_details @> '{"request_tax_invoice": true}'::jsonb
      AND NOT COALESCE(billing_details @> '{"account_confirmed_tax": true}'::jsonb, false)
      AND status != ALL(v_excluded)
      AND admin_user IN (
        SELECT DISTINCT TRIM(u.username) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.username IS NOT NULL AND TRIM(u.username) <> ''
        UNION
        SELECT DISTINCT TRIM(u.email) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.email IS NOT NULL AND TRIM(u.email) <> ''
      );
  ELSE
    SELECT count(*) INTO v_tax_pending
    FROM or_orders
    WHERE billing_details @> '{"request_tax_invoice": true}'::jsonb
      AND NOT COALESCE(billing_details @> '{"account_confirmed_tax": true}'::jsonb, false)
      AND status != ALL(v_excluded);
  END IF;

  IF v_is_sales_pump_owner THEN
    SELECT count(*) INTO v_cash_pending
    FROM or_orders
    WHERE billing_details @> '{"request_cash_bill": true}'::jsonb
      AND NOT COALESCE(billing_details @> '{"account_confirmed_cash": true}'::jsonb, false)
      AND status != ALL(v_excluded)
      AND admin_user = p_username;
  ELSIF v_is_sales_tr_team THEN
    SELECT count(*) INTO v_cash_pending
    FROM or_orders
    WHERE billing_details @> '{"request_cash_bill": true}'::jsonb
      AND NOT COALESCE(billing_details @> '{"account_confirmed_cash": true}'::jsonb, false)
      AND status != ALL(v_excluded)
      AND admin_user IN (
        SELECT DISTINCT TRIM(u.username) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.username IS NOT NULL AND TRIM(u.username) <> ''
        UNION
        SELECT DISTINCT TRIM(u.email) FROM us_users u
        WHERE u.role = 'sales-tr' AND u.email IS NOT NULL AND TRIM(u.email) <> ''
      );
  ELSE
    SELECT count(*) INTO v_cash_pending
    FROM or_orders
    WHERE billing_details @> '{"request_cash_bill": true}'::jsonb
      AND NOT COALESCE(billing_details @> '{"account_confirmed_cash": true}'::jsonb, false)
      AND status != ALL(v_excluded);
  END IF;

  SELECT count(DISTINCT m.order_id) INTO v_manual_slip_pending
  FROM ac_manual_slip_checks m
  WHERE m.status = 'pending';

  SELECT count(*) INTO v_amendment_pending
  FROM or_order_amendments a
  WHERE a.status = 'pending';

  SELECT count(*) INTO v_claim_pending
  FROM or_claim_requests c
  WHERE c.status = 'pending';

  RETURN jsonb_build_object(
    'orders', v_orders_pending,
    'orders_req_claim_shipping', v_orders_req_claim_shipping,
    'admin_qc', v_admin_qc,
    'qc_reject', v_qc_reject,
    'packing', v_packing,
    'warehouse', v_warehouse,
    'refund_pending', v_refund_pending,
    'tax_pending', v_tax_pending,
    'cash_pending', v_cash_pending,
    'manual_slip_pending', v_manual_slip_pending,
    'amendment_pending', v_amendment_pending,
    'claim_pending', v_claim_pending
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_sidebar_counts(TEXT, TEXT) TO authenticated;

COMMIT;

