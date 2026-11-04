-- 228: คิวคำขอเคลม (ส่งอนุมัติก่อนสร้างบิล REQ) + RPC + sidebar

BEGIN;

CREATE TABLE IF NOT EXISTS or_claim_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_order_id UUID NOT NULL REFERENCES or_orders(id) ON DELETE CASCADE,
  claim_type TEXT NOT NULL,
  proposed_snapshot JSONB NOT NULL,
  ref_snapshot JSONB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_by UUID REFERENCES us_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by UUID REFERENCES us_users(id),
  reviewed_at TIMESTAMPTZ,
  rejected_reason TEXT,
  created_claim_order_id UUID REFERENCES or_orders(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_or_claim_requests_one_pending_per_ref
  ON or_claim_requests (ref_order_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_or_claim_requests_status_created
  ON or_claim_requests (status, created_at DESC);

ALTER TABLE or_claim_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "or_claim_requests_select_authenticated"
  ON or_claim_requests FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "or_claim_requests_insert_authorized"
  ON or_claim_requests FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users u
      WHERE u.id = auth.uid()
        AND u.role IN ('superadmin', 'admin', 'sales-tr', 'sales-pump', 'qc_order', 'account')
    )
    AND EXISTS (
      SELECT 1 FROM or_orders o
      WHERE o.id = or_claim_requests.ref_order_id
        AND o.status = 'จัดส่งแล้ว'
    )
  );


CREATE OR REPLACE FUNCTION rpc_approve_claim_request(p_request_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_role           TEXT;
  v_uid            UUID := auth.uid();
  v_req            RECORD;
  v_ref            RECORD;
  v_claim_bill     TEXT;
  v_order          JSONB;
  v_items          JSONB;
  v_new_order_id   UUID;
  v_item           JSONB;
  v_idx            INT := 0;
  v_item_uid       TEXT;
  v_pay_date       DATE;
  v_pay_time       TIME;
  v_sched          TIMESTAMPTZ;
BEGIN
  SELECT u.role INTO v_role FROM us_users u WHERE u.id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติเคลม (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT * INTO v_req FROM or_claim_requests WHERE id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขอเคลม'; END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'คำขอนี้ไม่อยู่ในสถานะรออนุมัติ (status: %)', v_req.status;
  END IF;

  SELECT * INTO v_ref FROM or_orders WHERE id = v_req.ref_order_id;
  IF v_ref.id IS NULL THEN RAISE EXCEPTION 'ไม่พบบิลอ้างอิง'; END IF;
  IF v_ref.status IS DISTINCT FROM 'จัดส่งแล้ว' THEN
    RAISE EXCEPTION 'บิลอ้างอิงต้องเป็นสถานะจัดส่งแล้ว (ปัจจุบัน: %)', v_ref.status;
  END IF;

  v_claim_bill := 'REQ' || trim(both FROM COALESCE(v_ref.bill_no, ''));
  IF length(trim(both FROM COALESCE(v_ref.bill_no, ''))) = 0 THEN
    RAISE EXCEPTION 'บิลอ้างอิงไม่มีเลขบิล';
  END IF;

  IF EXISTS (SELECT 1 FROM or_orders o WHERE o.bill_no = v_claim_bill) THEN
    RAISE EXCEPTION 'มีบิลเคลม % อยู่แล้ว', v_claim_bill;
  END IF;

  v_order := v_req.proposed_snapshot->'order';
  IF v_order IS NULL OR jsonb_typeof(v_order) <> 'object' THEN
    RAISE EXCEPTION 'ข้อมูลคำขอไม่สมบูรณ์ (order)';
  END IF;

  v_items := v_req.proposed_snapshot->'items';
  IF v_items IS NULL OR jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'ต้องมีรายการสินค้าอย่างน้อย 1 รายการ';
  END IF;

  IF v_order->>'payment_date' IS NOT NULL AND length(trim(v_order->>'payment_date')) > 0 THEN
    v_pay_date := (v_order->>'payment_date')::DATE;
  ELSE
    v_pay_date := v_ref.payment_date;
  END IF;

  IF v_order->>'payment_time' IS NOT NULL AND length(trim(v_order->>'payment_time')) > 0 THEN
    v_pay_time := (v_order->>'payment_time')::TIME;
  ELSE
    v_pay_time := v_ref.payment_time;
  END IF;

  IF v_order->>'scheduled_pickup_at' IS NOT NULL AND length(trim(v_order->>'scheduled_pickup_at')) > 0 THEN
    v_sched := (v_order->>'scheduled_pickup_at')::TIMESTAMPTZ;
  ELSE
    v_sched := v_ref.scheduled_pickup_at;
  END IF;

  INSERT INTO or_orders (
    channel_code,
    customer_name,
    customer_address,
    channel_order_no,
    recipient_name,
    scheduled_pickup_at,
    price,
    shipping_cost,
    discount,
    total_amount,
    payment_method,
    promotion,
    payment_date,
    payment_time,
    status,
    admin_user,
    entry_date,
    bill_no,
    claim_type,
    claim_details,
    billing_details,
    packing_meta,
    work_order_name,
    work_order_id,
    shipped_by,
    shipped_time,
    tracking_number,
    requires_confirm_design
  ) VALUES (
    COALESCE(NULLIF(trim(both FROM v_order->>'channel_code'), ''), v_ref.channel_code),
    COALESCE(v_order->>'customer_name', v_ref.customer_name),
    COALESCE(v_order->>'customer_address', v_ref.customer_address),
    CASE
      WHEN v_order ? 'channel_order_no' THEN NULLIF(trim(both FROM v_order->>'channel_order_no'), '')::TEXT
      ELSE v_ref.channel_order_no
    END,
    CASE
      WHEN v_order ? 'recipient_name' THEN NULLIF(trim(both FROM v_order->>'recipient_name'), '')::TEXT
      ELSE v_ref.recipient_name
    END,
    v_sched,
    COALESCE((v_order->>'price')::NUMERIC, v_ref.price, 0),
    COALESCE((v_order->>'shipping_cost')::NUMERIC, v_ref.shipping_cost, 0),
    COALESCE((v_order->>'discount')::NUMERIC, v_ref.discount, 0),
    COALESCE((v_order->>'total_amount')::NUMERIC, v_ref.total_amount, 0),
    CASE
      WHEN v_order ? 'payment_method' THEN NULLIF(v_order->>'payment_method', '')::TEXT
      ELSE v_ref.payment_method
    END,
    CASE
      WHEN v_order ? 'promotion' THEN NULLIF(v_order->>'promotion', '')::TEXT
      ELSE v_ref.promotion
    END,
    v_pay_date,
    v_pay_time,
    COALESCE(NULLIF(trim(both FROM v_order->>'status'), ''), 'รอลงข้อมูล'),
    COALESCE(NULLIF(trim(both FROM v_order->>'admin_user'), ''), v_ref.admin_user),
    COALESCE(
      CASE WHEN v_order->>'entry_date' IS NOT NULL AND length(trim(v_order->>'entry_date')) > 0
        THEN (v_order->>'entry_date')::DATE END,
      CURRENT_DATE
    ),
    v_claim_bill,
    trim(both FROM v_req.claim_type),
    CASE WHEN v_order ? 'claim_details' THEN NULLIF(v_order->>'claim_details', '')::TEXT END,
    COALESCE(v_order->'billing_details', v_ref.billing_details),
    CASE WHEN v_order ? 'packing_meta' THEN v_order->'packing_meta' END,
    CASE WHEN v_order ? 'work_order_name' THEN NULLIF(trim(both FROM v_order->>'work_order_name'), '')::TEXT END,
    NULL,
    CASE WHEN v_order ? 'shipped_by' THEN NULLIF(trim(both FROM v_order->>'shipped_by'), '')::TEXT END,
    CASE
      WHEN v_order ? 'shipped_time' AND v_order->>'shipped_time' IS NOT NULL AND length(trim(v_order->>'shipped_time')) > 0
        THEN (v_order->>'shipped_time')::TIMESTAMPTZ
      ELSE v_ref.shipped_time
    END,
    CASE WHEN v_order ? 'tracking_number' THEN NULLIF(trim(both FROM v_order->>'tracking_number'), '')::TEXT
      ELSE v_ref.tracking_number
    END,
    COALESCE((v_order->>'requires_confirm_design')::BOOLEAN, v_ref.requires_confirm_design, TRUE)
  )
  RETURNING id INTO v_new_order_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) AS t(value)
  LOOP
    v_idx := v_idx + 1;
    v_item_uid := v_claim_bill || '-' || v_idx::TEXT;

    INSERT INTO or_order_items (
      order_id,
      item_uid,
      product_id,
      product_name,
      quantity,
      unit_price,
      ink_color,
      product_type,
      cartoon_pattern,
      line_pattern,
      font,
      line_1,
      line_2,
      line_3,
      no_name_line,
      is_free,
      notes,
      file_attachment
    ) VALUES (
      v_new_order_id,
      v_item_uid,
      NULLIF(trim(both FROM v_item->>'product_id'), '')::UUID,
      COALESCE(trim(both FROM v_item->>'product_name'), ''),
      COALESCE((v_item->>'quantity')::INT, 1),
      COALESCE((v_item->>'unit_price')::NUMERIC, 0),
      NULLIF(trim(both FROM v_item->>'ink_color'), '')::TEXT,
      COALESCE(NULLIF(trim(both FROM v_item->>'product_type'), '')::TEXT, 'ชั้น1'),
      NULLIF(trim(both FROM v_item->>'cartoon_pattern'), '')::TEXT,
      NULLIF(trim(both FROM v_item->>'line_pattern'), '')::TEXT,
      NULLIF(trim(both FROM v_item->>'font'), '')::TEXT,
      NULLIF(trim(both FROM v_item->>'line_1'), '')::TEXT,
      NULLIF(trim(both FROM v_item->>'line_2'), '')::TEXT,
      NULLIF(trim(both FROM v_item->>'line_3'), '')::TEXT,
      COALESCE((v_item->>'no_name_line')::BOOLEAN, FALSE),
      COALESCE((v_item->>'is_free')::BOOLEAN, FALSE),
      NULLIF(trim(both FROM v_item->>'notes'), '')::TEXT,
      NULLIF(trim(both FROM v_item->>'file_attachment'), '')::TEXT
    );
  END LOOP;

  UPDATE or_claim_requests
  SET status = 'approved',
      reviewed_by = v_uid,
      reviewed_at = NOW(),
      created_claim_order_id = v_new_order_id
  WHERE id = p_request_id;

  RETURN jsonb_build_object(
    'order_id', v_new_order_id,
    'bill_no', v_claim_bill
  );
END;
$func$;

CREATE OR REPLACE FUNCTION rpc_reject_claim_request(p_request_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_role TEXT;
  v_uid  UUID := auth.uid();
  v_n    INT;
BEGIN
  SELECT u.role INTO v_role FROM us_users u WHERE u.id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ปฏิเสธเคลม (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  UPDATE or_claim_requests r
  SET status = 'rejected',
      reviewed_by = v_uid,
      reviewed_at = NOW(),
      rejected_reason = NULLIF(trim(both FROM p_reason), '')
  WHERE r.id = p_request_id
    AND r.status = 'pending';

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'ไม่พบคำขอที่รออนุมัติ หรืออัปเดตไม่สำเร็จ';
  END IF;
END;
$func$;

GRANT EXECUTE ON FUNCTION rpc_approve_claim_request(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_reject_claim_request(UUID, TEXT) TO authenticated;


-- รวมตัวเลขเมนูบัญชีใน sidebar: ตรวจสลิปมือ + ขอยกเลิกบิล + โอนคืน + ใบกำกับภาษี
-- manual_slip = จำนวน order ที่มีแถว pending ใน ac_manual_slip_checks (สอดคล้องหน้า Account)
-- amendment = คำขอ or_order_amendments status pending

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

  -- คิวบัญชี: สอดคล้อง loadQueueCounts ใน Account.tsx (ทั้งระบบ ไม่กรอง owner)
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
