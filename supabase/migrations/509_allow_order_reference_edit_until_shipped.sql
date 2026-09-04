-- Allow the Account > Bill Edit limited mode to update order references and
-- name lines until the parcel is shipped. The row lock prevents a concurrent
-- packing shipment from racing with this edit.
BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_update_order_limited_fields(
  p_order_id UUID,
  p_lines JSONB,
  p_channel_order_no TEXT,
  p_tracking_number TEXT,
  p_express_receipt_number TEXT,
  p_edited_by TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_order RECORD;
  v_pending_amend INT := 0;
  v_channel_order_no TEXT := nullif(trim(coalesce(p_channel_order_no, '')), '');
  v_tracking_number TEXT := nullif(trim(coalesce(p_tracking_number, '')), '');
  v_express_receipt_number TEXT := nullif(trim(coalesce(p_express_receipt_number, '')), '');
  v_elem JSONB;
  v_uid TEXT;
  v_row RECORD;
  v_new_l1 TEXT;
  v_new_l2 TEXT;
  v_new_l3 TEXT;
  v_changes JSONB := '[]'::jsonb;
BEGIN
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'p_order_id ห้ามว่าง';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'p_lines ต้องเป็น JSON array';
  END IF;

  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'account', 'sales-tr', 'sales-pump') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไขบิล (role: %)', coalesce(v_role, 'unknown');
  END IF;

  SELECT id, status, shipped_time, bill_no, is_locked, work_order_id, work_order_name,
         channel_order_no, tracking_number, express_receipt_number
  INTO v_order
  FROM public.or_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN RAISE EXCEPTION 'ไม่พบออเดอร์'; END IF;
  IF v_order.is_locked THEN RAISE EXCEPTION 'บิลถูกล็อก'; END IF;
  IF v_order.status = 'จัดส่งแล้ว' OR v_order.shipped_time IS NOT NULL THEN
    RAISE EXCEPTION 'บิลจัดส่งแล้ว ไม่สามารถแก้ไขข้อมูลได้';
  END IF;
  IF v_order.status = 'ยกเลิก' THEN
    RAISE EXCEPTION 'บิลถูกยกเลิกแล้ว';
  END IF;
  IF v_order.work_order_id IS NULL
     AND nullif(trim(coalesce(v_order.work_order_name, '')), '') IS NULL THEN
    RAISE EXCEPTION 'บิลยังไม่ผูกใบงาน กรุณาใช้การแก้ไขบิลแบบเต็ม';
  END IF;

  SELECT count(*) INTO v_pending_amend
  FROM public.or_order_amendments
  WHERE order_id = p_order_id AND status = 'pending';
  IF v_pending_amend > 0 THEN
    RAISE EXCEPTION 'บิลมีคำขอยกเลิกรออนุมัติ';
  END IF;

  IF v_tracking_number IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.or_orders
    WHERE id <> p_order_id AND tracking_number = v_tracking_number
  ) THEN
    RAISE EXCEPTION 'เลขพัสดุซ้ำกับรายการในระบบ';
  END IF;

  IF v_order.channel_order_no IS DISTINCT FROM v_channel_order_no THEN
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'channel_order_no', 'label', 'เลขคำสั่งซื้อ',
      'before', coalesce(v_order.channel_order_no, ''), 'after', coalesce(v_channel_order_no, '')
    ));
  END IF;
  IF v_order.tracking_number IS DISTINCT FROM v_tracking_number THEN
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'tracking_number', 'label', 'เลขพัสดุ',
      'before', coalesce(v_order.tracking_number, ''), 'after', coalesce(v_tracking_number, '')
    ));
  END IF;
  IF v_order.express_receipt_number IS DISTINCT FROM v_express_receipt_number THEN
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'field', 'express_receipt_number', 'label', 'เลขรับพัสดุด่วน',
      'before', coalesce(v_order.express_receipt_number, ''), 'after', coalesce(v_express_receipt_number, '')
    ));
  END IF;

  UPDATE public.or_orders
  SET channel_order_no = v_channel_order_no,
      tracking_number = v_tracking_number,
      express_receipt_number = v_express_receipt_number,
      last_edited_by = coalesce(nullif(trim(p_edited_by), ''), 'unknown')
  WHERE id = p_order_id;

  FOR v_elem IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    CONTINUE WHEN v_elem IS NULL OR jsonb_typeof(v_elem) <> 'object';
    v_uid := trim(coalesce(v_elem->>'item_uid', ''));
    CONTINUE WHEN v_uid = '';

    SELECT * INTO v_row
    FROM public.or_order_items
    WHERE order_id = p_order_id AND item_uid = v_uid
    FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบรายการ item_uid=%', v_uid; END IF;
    IF coalesce(v_row.no_name_line, false) THEN
      CONTINUE;
    END IF;

    v_new_l1 := nullif(trim(coalesce(v_elem->>'line_1', '')), '');
    v_new_l2 := nullif(trim(coalesce(v_elem->>'line_2', '')), '');
    v_new_l3 := nullif(trim(coalesce(v_elem->>'line_3', '')), '');

    IF v_row.line_1 IS DISTINCT FROM v_new_l1 THEN
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'field', 'line_1:' || v_uid, 'label', format('บรรทัด 1 (%s)', v_uid),
        'before', coalesce(v_row.line_1, ''), 'after', coalesce(v_new_l1, '')
      ));
    END IF;
    IF v_row.line_2 IS DISTINCT FROM v_new_l2 THEN
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'field', 'line_2:' || v_uid, 'label', format('บรรทัด 2 (%s)', v_uid),
        'before', coalesce(v_row.line_2, ''), 'after', coalesce(v_new_l2, '')
      ));
    END IF;
    IF v_row.line_3 IS DISTINCT FROM v_new_l3 THEN
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'field', 'line_3:' || v_uid, 'label', format('บรรทัด 3 (%s)', v_uid),
        'before', coalesce(v_row.line_3, ''), 'after', coalesce(v_new_l3, '')
      ));
    END IF;

    IF v_row.line_1 IS DISTINCT FROM v_new_l1
       OR v_row.line_2 IS DISTINCT FROM v_new_l2
       OR v_row.line_3 IS DISTINCT FROM v_new_l3 THEN
      UPDATE public.or_order_items
      SET line_1 = v_new_l1, line_2 = v_new_l2, line_3 = v_new_l3, updated_at = now()
      WHERE id = v_row.id;
    END IF;
  END LOOP;

  IF jsonb_array_length(v_changes) > 0 THEN
    INSERT INTO public.ac_bill_edit_logs (
      order_id, bill_no, edited_by, changes, snapshot_before, snapshot_after
    ) VALUES (
      p_order_id,
      nullif(v_order.bill_no, ''),
      coalesce(nullif(trim(p_edited_by), ''), 'unknown'),
      v_changes,
      NULL,
      NULL
    );
  END IF;

  RETURN jsonb_build_object('success', true, 'changes_count', jsonb_array_length(v_changes));
END;
$$;

COMMENT ON FUNCTION public.rpc_update_order_limited_fields(UUID, JSONB, TEXT, TEXT, TEXT, TEXT) IS
'แก้เลขคำสั่งซื้อ เลขพัสดุ เลขรับพัสดุด่วน และบรรทัดชื่อของบิลที่ผูกใบงานได้จนกว่าจะจัดส่ง พร้อมบันทึกประวัติ';

GRANT EXECUTE ON FUNCTION public.rpc_update_order_limited_fields(UUID, JSONB, TEXT, TEXT, TEXT, TEXT) TO authenticated;

COMMIT;
