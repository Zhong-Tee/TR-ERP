-- Account > Bill edit: allow editing item name lines until the bill is shipped.
-- The write RPC locks the order row and checks both status and shipped_time so a
-- concurrent packing shipment cannot race with a late name edit.

BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_check_order_edit_eligibility(p_order_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_pending_amend INT := 0;
  v_linked BOOLEAN := false;
BEGIN
  SELECT id, status, shipped_time, work_order_id, work_order_name, bill_no, is_locked
  INTO v_order
  FROM public.or_orders
  WHERE id = p_order_id;

  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object('error', 'ไม่พบออเดอร์');
  END IF;

  IF v_order.is_locked THEN
    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'can_edit_name_lines_only', false,
      'needs_amendment', false,
      'needs_credit_note', false,
      'is_locked', true,
      'reason', 'บิลนี้ถูกล็อกแล้ว ไม่สามารถแก้ไขได้'
    );
  END IF;

  IF v_order.status = 'จัดส่งแล้ว' OR v_order.shipped_time IS NOT NULL THEN
    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'can_edit_name_lines_only', false,
      'needs_amendment', false,
      'needs_credit_note', false,
      'is_shipped', true,
      'order_status', v_order.status,
      'reason', 'บิลจัดส่งแล้ว — กรุณาใช้ระบบเคลมแทน'
    );
  END IF;

  IF v_order.status = 'ยกเลิก' THEN
    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'can_edit_name_lines_only', false,
      'needs_amendment', false,
      'needs_credit_note', false,
      'reason', 'บิลถูกยกเลิกแล้ว ไม่สามารถแก้ไขได้'
    );
  END IF;

  SELECT count(*) INTO v_pending_amend
  FROM public.or_order_amendments
  WHERE order_id = p_order_id AND status = 'pending';

  IF v_pending_amend > 0 THEN
    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'can_edit_name_lines_only', false,
      'needs_amendment', false,
      'needs_credit_note', false,
      'has_pending_amendment', true,
      'reason', 'บิลนี้มีคำขอยกเลิกรออนุมัติอยู่แล้ว'
    );
  END IF;

  v_linked := v_order.work_order_id IS NOT NULL
    OR nullif(trim(coalesce(v_order.work_order_name, '')), '') IS NOT NULL;

  IF v_linked THEN
    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'can_edit_name_lines_only', true,
      'needs_amendment', false,
      'needs_credit_note', false,
      'order_status', v_order.status,
      'reason', 'บิลยังไม่จัดส่ง — แก้ไขได้เฉพาะชื่อบรรทัด 1–3'
    );
  END IF;

  RETURN jsonb_build_object(
    'can_direct_edit', true,
    'can_edit_name_lines_only', false,
    'needs_amendment', false,
    'needs_credit_note', false,
    'order_status', v_order.status,
    'reason', 'สามารถแก้ไขได้โดยตรง'
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_check_order_edit_eligibility(UUID) IS
'บิลที่ผูกใบงานแก้ชื่อบรรทัด 1–3 ได้จนกว่า status=จัดส่งแล้ว หรือ shipped_time มีค่า';

CREATE OR REPLACE FUNCTION public.rpc_update_order_item_name_lines(
  p_order_id UUID,
  p_lines JSONB,
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
  IF v_role IS NULL OR v_role NOT IN (
    'superadmin', 'admin', 'account', 'sales-tr', 'sales-pump'
  ) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไขบิล (role: %)', coalesce(v_role, 'unknown');
  END IF;

  -- Locking the order serializes this edit with the packing shipment update.
  SELECT id, status, shipped_time, bill_no, is_locked, work_order_id, work_order_name
  INTO v_order
  FROM public.or_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN RAISE EXCEPTION 'ไม่พบออเดอร์'; END IF;
  IF v_order.is_locked THEN RAISE EXCEPTION 'บิลถูกล็อก'; END IF;
  IF v_order.status = 'จัดส่งแล้ว' OR v_order.shipped_time IS NOT NULL THEN
    RAISE EXCEPTION 'บิลจัดส่งแล้ว ไม่สามารถแก้ชื่อได้';
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
      RAISE EXCEPTION 'รายการ % ไม่รับชื่อ (no_name_line) ไม่สามารถแก้บรรทัดได้', v_uid;
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
      SET line_1 = v_new_l1,
          line_2 = v_new_l2,
          line_3 = v_new_l3,
          updated_at = now()
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

COMMENT ON FUNCTION public.rpc_update_order_item_name_lines(UUID, JSONB, TEXT) IS
'แก้ชื่อบรรทัด 1–3 ของบิลที่ผูกใบงาน จนกว่าบิลจะถูกจัดส่ง';

GRANT EXECUTE ON FUNCTION public.rpc_check_order_edit_eligibility(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_order_item_name_lines(UUID, JSONB, TEXT) TO authenticated;

COMMIT;
