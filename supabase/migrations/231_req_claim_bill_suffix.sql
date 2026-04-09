-- เคลมซ้ำบิลเดิม: เลขบิล REQ รูปแบบ REQ{เลขบิลจัดส่ง}, REQ{เลขบิล}-2, REQ{เลขบิล}-3, ...

BEGIN;

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
  v_prefix         TEXT;
  v_i              INT := 1;
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

  IF length(trim(both FROM COALESCE(v_ref.bill_no, ''))) = 0 THEN
    RAISE EXCEPTION 'บิลอ้างอิงไม่มีเลขบิล';
  END IF;

  v_prefix := 'REQ' || trim(both FROM v_ref.bill_no);
  v_claim_bill := v_prefix;
  WHILE EXISTS (SELECT 1 FROM or_orders o WHERE o.bill_no = v_claim_bill) LOOP
    v_i := v_i + 1;
    IF v_i > 10000 THEN
      RAISE EXCEPTION 'ไม่พบเลขบิลเคลมว่างสำหรับบิลอ้างอิงนี้';
    END IF;
    v_claim_bill := v_prefix || '-' || v_i::TEXT;
  END LOOP;

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

COMMIT;
