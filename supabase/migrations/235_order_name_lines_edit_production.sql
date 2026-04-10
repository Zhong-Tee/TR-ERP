-- แก้ชื่อบรรทัด 1–3 เฉพาะบิลสถานะใบสั่งงาน / ใบงานกำลังผลิต (รวมบิลผูก work_order)
-- + rpc_update_order_item_name_lines + บันทึก ac_bill_edit_logs.changes

CREATE OR REPLACE FUNCTION rpc_check_order_edit_eligibility(p_order_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order         RECORD;
  v_pending_amend INT := 0;
  v_wo_name_trim  TEXT;
BEGIN
  SELECT id, status, work_order_id, work_order_name, bill_no, is_locked
  INTO v_order
  FROM or_orders
  WHERE id = p_order_id;

  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object('error', 'ไม่พบออเดอร์');
  END IF;

  IF v_order.is_locked THEN
    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'needs_amendment', false,
      'needs_credit_note', false,
      'is_locked', true,
      'reason', 'บิลนี้ถูกล็อกแล้ว ไม่สามารถแก้ไขได้'
    );
  END IF;

  SELECT COUNT(*) INTO v_pending_amend
  FROM or_order_amendments
  WHERE order_id = p_order_id AND status = 'pending';

  IF v_pending_amend > 0 THEN
    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'needs_amendment', false,
      'needs_credit_note', false,
      'has_pending_amendment', true,
      'reason', 'บิลนี้มีคำขอยกเลิกรออนุมัติอยู่แล้ว'
    );
  END IF;

  IF v_order.status = 'จัดส่งแล้ว' THEN
    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'needs_amendment', false,
      'needs_credit_note', false,
      'is_shipped', true,
      'has_wms_activity', false,
      'order_status', v_order.status,
      'reason', 'บิลจัดส่งแล้ว — กรุณาใช้ระบบเคลมแทน'
    );
  END IF;

  IF v_order.status = 'ยกเลิก' THEN
    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'needs_amendment', false,
      'needs_credit_note', false,
      'reason', 'บิลถูกยกเลิกแล้ว ไม่สามารถแก้ไขได้'
    );
  END IF;

  -- ก่อนเช็คผูกใบงาน: สถานะผลิตอนุญาตแก้เฉพาะบรรทัดชื่อ (แม้มี work_order_id)
  IF v_order.status IN ('ใบสั่งงาน', 'ใบงานกำลังผลิต') THEN
    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'can_edit_name_lines_only', true,
      'needs_amendment', true,
      'needs_credit_note', false,
      'has_wms_activity', false,
      'wms_picked', 0,
      'wms_correct', 0,
      'order_status', v_order.status,
      'reason', 'แก้ข้อความบรรทัด 1–3 ได้จากหน้านี้ — ยกเลิก/แก้บิลเต็มรูปแบบผ่านคำขอ'
    );
  END IF;

  v_wo_name_trim := trim(both FROM coalesce(v_order.work_order_name, ''));
  IF v_order.work_order_id IS NOT NULL OR v_wo_name_trim <> '' THEN
    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'needs_amendment', true,
      'needs_credit_note', false,
      'order_status', v_order.status,
      'reason', 'บิลผูกใบงานแล้ว — ต้องขอยกเลิก/แก้ไขผ่านคำขอ'
    );
  END IF;

  RETURN jsonb_build_object(
    'can_direct_edit', true,
    'needs_amendment', false,
    'needs_credit_note', false,
    'has_wms_activity', false,
    'order_status', v_order.status,
    'reason', 'สามารถแก้ไขได้โดยตรง'
  );
END;
$$;

COMMENT ON FUNCTION rpc_check_order_edit_eligibility(UUID) IS
'ตรวจว่าแก้บิลตรงได้หรือไม่ — ใบสั่งงาน/ใบงานกำลังผลิต: can_edit_name_lines_only; บิลผูกใบงาน (สถานะอื่น) ต้องคำขอ; ไม่ผูกใบงาน = แก้ตรงได้';

CREATE OR REPLACE FUNCTION rpc_update_order_item_name_lines(
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
  v_role         TEXT;
  v_order        RECORD;
  v_pending_amend INT := 0;
  v_elem         JSONB;
  v_uid          TEXT;
  v_row          RECORD;
  v_new_l1       TEXT;
  v_new_l2       TEXT;
  v_new_l3       TEXT;
  v_changes      JSONB := '[]'::jsonb;
  v_bill_no      TEXT;
  v_i            INT;
  v_n            INT;
BEGIN
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'p_order_id ห้ามว่าง';
  END IF;

  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN (
    'superadmin', 'admin', 'admin-tr', 'admin-pump', 'account'
  ) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไขบิล (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT id, status, bill_no, is_locked
  INTO v_order
  FROM or_orders
  WHERE id = p_order_id;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'ไม่พบออเดอร์';
  END IF;

  IF v_order.is_locked THEN
    RAISE EXCEPTION 'บิลถูกล็อก';
  END IF;

  IF v_order.status NOT IN ('ใบสั่งงาน', 'ใบงานกำลังผลิต') THEN
    RAISE EXCEPTION 'อนุญาตเฉพาะบิลสถานะ ใบสั่งงาน หรือ ใบงานกำลังผลิต';
  END IF;

  SELECT COUNT(*) INTO v_pending_amend
  FROM or_order_amendments
  WHERE order_id = p_order_id AND status = 'pending';

  IF v_pending_amend > 0 THEN
    RAISE EXCEPTION 'บิลมีคำขอยกเลิกรออนุมัติ';
  END IF;

  v_bill_no := COALESCE(v_order.bill_no, '');

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'p_lines ต้องเป็น JSON array';
  END IF;

  v_n := COALESCE(jsonb_array_length(p_lines), 0);
  FOR v_i IN 0 .. v_n - 1
  LOOP
    v_elem := p_lines->v_i;
    IF v_elem IS NULL OR jsonb_typeof(v_elem) <> 'object' THEN
      CONTINUE;
    END IF;

    v_uid := trim(both FROM coalesce(v_elem->>'item_uid', ''));
    IF v_uid = '' THEN
      CONTINUE;
    END IF;

    SELECT *
    INTO v_row
    FROM or_order_items
    WHERE order_id = p_order_id AND item_uid = v_uid;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ไม่พบรายการ item_uid=%', v_uid;
    END IF;

    IF COALESCE(v_row.no_name_line, false) THEN
      RAISE EXCEPTION 'รายการ % ไม่รับชื่อ (no_name_line) ไม่สามารถแก้บรรทัดได้', v_uid;
    END IF;

    v_new_l1 := NULLIF(trim(both FROM coalesce(v_elem->>'line_1', '')), '');
    v_new_l2 := NULLIF(trim(both FROM coalesce(v_elem->>'line_2', '')), '');
    v_new_l3 := NULLIF(trim(both FROM coalesce(v_elem->>'line_3', '')), '');

    IF v_row.line_1 IS DISTINCT FROM v_new_l1 THEN
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'field', 'line_1:' || v_uid,
        'label', format('บรรทัด 1 (%s)', v_uid),
        'before', coalesce(v_row.line_1, ''),
        'after', coalesce(v_new_l1, '')
      ));
    END IF;

    IF v_row.line_2 IS DISTINCT FROM v_new_l2 THEN
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'field', 'line_2:' || v_uid,
        'label', format('บรรทัด 2 (%s)', v_uid),
        'before', coalesce(v_row.line_2, ''),
        'after', coalesce(v_new_l2, '')
      ));
    END IF;

    IF v_row.line_3 IS DISTINCT FROM v_new_l3 THEN
      v_changes := v_changes || jsonb_build_array(jsonb_build_object(
        'field', 'line_3:' || v_uid,
        'label', format('บรรทัด 3 (%s)', v_uid),
        'before', coalesce(v_row.line_3, ''),
        'after', coalesce(v_new_l3, '')
      ));
    END IF;

    IF v_row.line_1 IS DISTINCT FROM v_new_l1 OR
       v_row.line_2 IS DISTINCT FROM v_new_l2 OR
       v_row.line_3 IS DISTINCT FROM v_new_l3
    THEN
      UPDATE or_order_items
      SET
        line_1 = v_new_l1,
        line_2 = v_new_l2,
        line_3 = v_new_l3,
        updated_at = NOW()
      WHERE id = v_row.id;
    END IF;
  END LOOP;

  IF jsonb_array_length(v_changes) > 0 THEN
    INSERT INTO ac_bill_edit_logs (
      order_id, bill_no, edited_by, changes, snapshot_before, snapshot_after
    ) VALUES (
      p_order_id,
      NULLIF(v_bill_no, ''),
      COALESCE(NULLIF(trim(both FROM p_edited_by), ''), 'unknown'),
      v_changes,
      NULL,
      NULL
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'changes_count', jsonb_array_length(v_changes)
  );
END;
$$;

COMMENT ON FUNCTION rpc_update_order_item_name_lines(UUID, JSONB, TEXT) IS
'อัปเดตเฉพาะ line_1–line_3 ของรายการบิล สถานะใบสั่งงาน/ใบงานกำลังผลิต — บันทึก ac_bill_edit_logs.changes';

GRANT EXECUTE ON FUNCTION rpc_update_order_item_name_lines(UUID, JSONB, TEXT) TO authenticated;
