-- REQ บิลเคลม: ยืนยันที่อยู่จัดส่งหลังอนุมัติ + block เข้าคิวใบสั่งงานจนกว่าจะยืนยัน

BEGIN;

ALTER TABLE or_orders
  ADD COLUMN IF NOT EXISTS claim_shipping_confirmed_at TIMESTAMPTZ;

COMMENT ON COLUMN or_orders.claim_shipping_confirmed_at IS
  'เวลาที่ยืนยันชื่อผู้รับ/ที่อยู่/เบอร์สำหรับบิล REQ (บิลเคลม) — ว่าง = ยังไม่ยืนยัน';

-- บิล REQ ที่อยู่ในคิวใบสั่งงานอยู่แล้ว (ข้อมูลเก่า) — ถือว่ายืนยันแล้วเพื่อไม่ให้ค้างคิว
UPDATE or_orders SET claim_shipping_confirmed_at = COALESCE(updated_at, NOW())
WHERE bill_no LIKE 'REQ%'
  AND claim_shipping_confirmed_at IS NULL
  AND status = ANY (ARRAY['ใบสั่งงาน'::text, 'คอนเฟิร์มแล้ว', 'เสร็จสิ้น', 'ย้ายจากใบงาน', 'ใบงานกำลังผลิต']);

-- ─── Gate: ห้ามปรับสถานะเข้าคิว Plan (ใบสั่งงาน) ถ้า REQ ยังไม่ยืนยันที่อยู่ ───
CREATE OR REPLACE FUNCTION tr_fn_or_orders_req_shipping_gate()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $tr$
DECLARE
  v_wq text[] := ARRAY['ใบสั่งงาน','คอนเฟิร์มแล้ว','เสร็จสิ้น','ย้ายจากใบงาน'];
BEGIN
  IF NEW.bill_no IS NULL OR NEW.bill_no NOT LIKE 'REQ%' THEN
    RETURN NEW;
  END IF;
  IF NEW.claim_shipping_confirmed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status = ANY(v_wq)
     AND NOT (OLD.status = ANY(v_wq))
     AND OLD.status IS DISTINCT FROM 'ใบงานกำลังผลิต' THEN
    RAISE EXCEPTION
      'บิลเคลม (REQ): กรุณายืนยันที่อยู่จัดส่ง (ชื่อผู้รับ ที่อยู่ เบอร์โทร) ในเมนู ออเดอร์ → บิลเคลม (REQ) ก่อนปรับสถานะเป็น %',
      NEW.status
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$tr$;

DROP TRIGGER IF EXISTS tr_or_orders_req_shipping_gate ON or_orders;
CREATE TRIGGER tr_or_orders_req_shipping_gate
  BEFORE UPDATE ON or_orders
  FOR EACH ROW
  EXECUTE FUNCTION tr_fn_or_orders_req_shipping_gate();

-- ─── RPC: บันทึกผู้รับ + ที่อยู่ + เบอร์ (billing_details.mobile_phone) + ตั้งเวลายืนยัน ───
CREATE OR REPLACE FUNCTION rpc_confirm_claim_req_shipping(
  p_order_id UUID,
  p_recipient_name TEXT,
  p_customer_address TEXT,
  p_mobile_phone TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_role TEXT;
  v_rec TEXT := trim(both FROM coalesce(p_recipient_name, ''));
  v_addr TEXT := trim(both FROM coalesce(p_customer_address, ''));
  v_phone TEXT := trim(both FROM coalesce(p_mobile_phone, ''));
  v_bill TEXT;
  v_bd jsonb;
BEGIN
  SELECT u.role INTO v_role FROM us_users u WHERE u.id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'sales-tr', 'sales-pump') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ยืนยันที่อยู่บิลเคลม (REQ)';
  END IF;

  SELECT o.bill_no, o.billing_details INTO v_bill, v_bd
  FROM or_orders o WHERE o.id = p_order_id FOR UPDATE;

  IF v_bill IS NULL THEN
    RAISE EXCEPTION 'ไม่พบบิล';
  END IF;
  IF v_bill NOT LIKE 'REQ%' THEN
    RAISE EXCEPTION 'บิลนี้ไม่ใช่บิลเคลม (REQ)';
  END IF;

  IF length(v_rec) = 0 OR length(v_addr) = 0 OR length(v_phone) = 0 THEN
    RAISE EXCEPTION 'กรุณากรอกชื่อผู้รับ ที่อยู่จัดส่ง และเบอร์โทรให้ครบ';
  END IF;

  v_bd := coalesce(v_bd, '{}'::jsonb);
  v_bd := v_bd || jsonb_build_object('mobile_phone', v_phone);

  UPDATE or_orders SET
    recipient_name = v_rec,
    customer_address = v_addr,
    billing_details = v_bd,
    claim_shipping_confirmed_at = NOW(),
    updated_at = NOW()
  WHERE id = p_order_id;

  RETURN jsonb_build_object('success', true);
END;
$fn$;

REVOKE ALL ON FUNCTION rpc_confirm_claim_req_shipping(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_confirm_claim_req_shipping(UUID, TEXT, TEXT, TEXT) TO authenticated;

-- ─── Sidebar: นับ REQ ที่ยังไม่ยืนยันที่อยู่ ───
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
BEGIN
  v_is_sales_pump_owner := (p_role = 'sales-pump' AND p_username <> '');
  v_is_sales_tr_team := (p_role = 'sales-tr');

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
    WHERE status = 'ตรวจสอบแล้ว'
      AND channel_code IS DISTINCT FROM 'PUMP'
      AND admin_user = p_username;
  ELSIF v_is_sales_tr_team THEN
    SELECT count(*) INTO v_admin_qc
    FROM or_orders
    WHERE status = 'ตรวจสอบแล้ว'
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

  SELECT count(*) INTO v_warehouse
  FROM pr_products p
  LEFT JOIN inv_stock_balances b ON b.product_id = p.id
  WHERE p.is_active = true
    AND COALESCE(p.is_hold, false) = false
    AND p.order_point IS NOT NULL
    AND NULLIF(TRIM(REPLACE(p.order_point::text, ',', '')), '') IS NOT NULL
    AND NULLIF(TRIM(REPLACE(p.order_point::text, ',', '')), '')::numeric > 0
    AND COALESCE(b.on_hand, 0) < NULLIF(TRIM(REPLACE(p.order_point::text, ',', '')), '')::numeric;

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
