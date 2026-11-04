-- =====================================================================
-- RPC: get_sidebar_counts(p_username, p_role)
-- เพิ่ม parameter p_username และ p_role เพื่อกรอง admin_user
-- สำหรับ role admin-tr / admin-pump ให้เห็นเฉพาะ orders ของตัวเอง
-- ตรงกับ logic ของ Tab counts ในหน้า Orders
-- =====================================================================

-- Drop old overload (no-param version) to avoid ambiguity
DROP FUNCTION IF EXISTS get_sidebar_counts();

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
  -- ตรวจว่าเป็น owner role หรือไม่
  v_is_owner := (p_role IN ('admin-tr', 'admin-pump') AND p_username <> '');

  -- 1. Orders pending (รอดำเนินการ)
  IF v_is_owner THEN
    SELECT count(*) INTO v_orders_pending
    FROM or_orders WHERE status = ANY(v_excluded) AND admin_user = p_username;
  ELSE
    SELECT count(*) INTO v_orders_pending
    FROM or_orders WHERE status = ANY(v_excluded);
  END IF;

  -- 2. Admin QC (ตรวจสอบแล้ว, ไม่รวม PUMP)
  IF v_is_owner THEN
    SELECT count(*) INTO v_admin_qc
    FROM or_orders WHERE status = 'ตรวจสอบแล้ว' AND channel_code IS DISTINCT FROM 'PUMP' AND admin_user = p_username;
  ELSE
    SELECT count(*) INTO v_admin_qc
    FROM or_orders WHERE status = 'ตรวจสอบแล้ว' AND channel_code IS DISTINCT FROM 'PUMP';
  END IF;

  -- 3. QC Reject (ไม่กรองตาม owner — เป็นข้อมูล QC ส่วนกลาง)
  SELECT count(*) INTO v_qc_reject
  FROM qc_records WHERE is_rejected = true;

  -- 4. Packing (กำลังผลิต) — ไม่กรองตาม owner
  SELECT count(*) INTO v_packing
  FROM or_work_orders WHERE status = 'กำลังผลิต';

  -- 5. Warehouse: สินค้าต่ำกว่าจุดสั่งซื้อ — ไม่กรองตาม owner
  SELECT count(*) INTO v_warehouse
  FROM pr_products p
  LEFT JOIN inv_stock_balances b ON b.product_id = p.id
  WHERE p.is_active = true
    AND p.order_point IS NOT NULL
    AND NULLIF(TRIM(REPLACE(p.order_point::text, ',', '')), '') IS NOT NULL
    AND NULLIF(TRIM(REPLACE(p.order_point::text, ',', '')), '')::numeric > 0
    AND COALESCE(b.on_hand, 0) < NULLIF(TRIM(REPLACE(p.order_point::text, ',', '')), '')::numeric;

  -- 6. Refund pending (โอนเกิน + จัดส่งแล้ว)
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

  -- 7. Tax invoice pending
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

  -- 8. Cash bill pending
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

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION get_sidebar_counts(TEXT, TEXT) TO authenticated;
