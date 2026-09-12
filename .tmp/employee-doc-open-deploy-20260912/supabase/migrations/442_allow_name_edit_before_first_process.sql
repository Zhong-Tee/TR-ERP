-- Allow Account > Bill edit to change item name lines while the linked work
-- order has not started.  A requisition track is ignored when the work order
-- has no product category that WMS would pick.

CREATE OR REPLACE FUNCTION public.fn_order_work_order_has_started(p_order_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_work_order_id UUID;
  v_work_order_name TEXT;
  v_tracks JSONB;
  v_has_pickable BOOLEAN := false;
  v_dept RECORD;
  v_step RECORD;
BEGIN
  SELECT o.work_order_id, nullif(trim(o.work_order_name), '')
  INTO v_work_order_id, v_work_order_name
  FROM public.or_orders o
  WHERE o.id = p_order_id;

  IF v_work_order_id IS NULL AND v_work_order_name IS NULL THEN
    RETURN false;
  END IF;

  SELECT pj.tracks
  INTO v_tracks
  FROM public.plan_jobs pj
  WHERE (v_work_order_id IS NOT NULL AND pj.work_order_id = v_work_order_id)
     OR (v_work_order_id IS NULL AND trim(pj.name) = v_work_order_name)
  ORDER BY CASE WHEN pj.work_order_id = v_work_order_id THEN 0 ELSE 1 END
  LIMIT 1;

  IF v_tracks IS NULL OR jsonb_typeof(v_tracks) <> 'object' THEN
    RETURN false;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.or_orders o
    JOIN public.or_order_items oi ON oi.order_id = o.id
    JOIN public.pr_products p ON p.id = oi.product_id
    WHERE NOT coalesce(oi.is_detail_row, false)
      AND public.fn_wms_is_pickable_category(p.product_category::text)
      AND (
        (v_work_order_id IS NOT NULL AND o.work_order_id = v_work_order_id)
        OR (
          v_work_order_id IS NULL
          AND trim(coalesce(o.work_order_name, '')) = v_work_order_name
        )
      )
  ) INTO v_has_pickable;

  FOR v_dept IN SELECT * FROM jsonb_each(v_tracks)
  LOOP
    CONTINUE WHEN v_dept.value IS NULL OR jsonb_typeof(v_dept.value) <> 'object';
    CONTINUE WHEN v_dept.key = 'เบิก' AND NOT v_has_pickable;

    FOR v_step IN SELECT * FROM jsonb_each(v_dept.value)
    LOOP
      CONTINUE WHEN v_step.key = 'เตรียมไฟล์';
      CONTINUE WHEN v_step.value IS NULL OR jsonb_typeof(v_step.value) <> 'object';
      IF nullif(trim(v_step.value->>'start'), '') IS NOT NULL THEN
        RETURN true;
      END IF;
    END LOOP;
  END LOOP;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_order_work_order_has_started(UUID) FROM PUBLIC;

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
  v_started BOOLEAN := false;
BEGIN
  SELECT id, status, work_order_id, work_order_name, bill_no, is_locked
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

  IF v_order.status = 'จัดส่งแล้ว' THEN
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

  v_linked := v_order.work_order_id IS NOT NULL
    OR nullif(trim(coalesce(v_order.work_order_name, '')), '') IS NOT NULL;

  IF v_order.status IN ('ใบสั่งงาน', 'ใบงานกำลังผลิต') THEN
    v_started := v_linked AND public.fn_order_work_order_has_started(p_order_id);

    IF NOT v_started THEN
      RETURN jsonb_build_object(
        'can_direct_edit', false,
        'can_edit_name_lines_only', true,
        'needs_amendment', false,
        'needs_credit_note', false,
        'first_process_started', false,
        'order_status', v_order.status,
        'reason', 'ใบงานยังไม่เริ่มกระบวนการ — แก้ไขได้เฉพาะชื่อบรรทัด 1–3'
      );
    END IF;

    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'can_edit_name_lines_only', false,
      'needs_amendment', true,
      'needs_credit_note', false,
      'first_process_started', true,
      'order_status', v_order.status,
      'reason', 'ใบงานเริ่มกระบวนการแรกแล้ว ไม่สามารถแก้ไขชื่อบิลได้'
    );
  END IF;

  IF v_linked THEN
    RETURN jsonb_build_object(
      'can_direct_edit', false,
      'can_edit_name_lines_only', false,
      'needs_amendment', true,
      'needs_credit_note', false,
      'order_status', v_order.status,
      'reason', 'บิลผูกใบงานแล้ว — ต้องขอยกเลิก/แก้ไขผ่านคำขอ'
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
'ใบงานสถานะผลิตแก้ชื่อบรรทัดได้ก่อนเริ่มกระบวนการ โดยข้ามขั้นเบิกเมื่อไม่มีสินค้าที่ WMS ต้องหยิบ';

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
  v_i INT;
  v_n INT;
BEGIN
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'p_order_id ห้ามว่าง';
  END IF;

  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN (
    'superadmin', 'admin', 'account', 'sales-tr', 'sales-pump'
  ) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไขบิล (role: %)', coalesce(v_role, 'unknown');
  END IF;

  SELECT id, status, bill_no, is_locked, work_order_id, work_order_name
  INTO v_order
  FROM public.or_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN RAISE EXCEPTION 'ไม่พบออเดอร์'; END IF;
  IF v_order.is_locked THEN RAISE EXCEPTION 'บิลถูกล็อก'; END IF;
  IF v_order.status NOT IN ('ใบสั่งงาน', 'ใบงานกำลังผลิต') THEN
    RAISE EXCEPTION 'อนุญาตเฉพาะบิลสถานะ ใบสั่งงาน หรือ ใบงานกำลังผลิต';
  END IF;

  SELECT count(*) INTO v_pending_amend
  FROM public.or_order_amendments
  WHERE order_id = p_order_id AND status = 'pending';
  IF v_pending_amend > 0 THEN
    RAISE EXCEPTION 'บิลมีคำขอยกเลิกรออนุมัติ';
  END IF;

  -- Serialize against Plan track changes before checking the start condition.
  PERFORM 1
  FROM public.plan_jobs pj
  WHERE (v_order.work_order_id IS NOT NULL AND pj.work_order_id = v_order.work_order_id)
     OR (
       v_order.work_order_id IS NULL
       AND nullif(trim(coalesce(v_order.work_order_name, '')), '') IS NOT NULL
       AND trim(pj.name) = trim(v_order.work_order_name)
     )
  FOR UPDATE;

  IF public.fn_order_work_order_has_started(p_order_id) THEN
    RAISE EXCEPTION 'ใบงานเริ่มกระบวนการแรกแล้ว ไม่สามารถแก้ไขชื่อบิลได้';
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'p_lines ต้องเป็น JSON array';
  END IF;

  v_n := coalesce(jsonb_array_length(p_lines), 0);
  IF v_n > 0 THEN
    FOR v_i IN 0 .. v_n - 1 LOOP
      v_elem := p_lines->v_i;
      CONTINUE WHEN v_elem IS NULL OR jsonb_typeof(v_elem) <> 'object';
      v_uid := trim(coalesce(v_elem->>'item_uid', ''));
      CONTINUE WHEN v_uid = '';

      SELECT * INTO v_row
      FROM public.or_order_items
      WHERE order_id = p_order_id AND item_uid = v_uid;

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
        SET line_1 = v_new_l1, line_2 = v_new_l2, line_3 = v_new_l3, updated_at = now()
        WHERE id = v_row.id;
      END IF;
    END LOOP;
  END IF;

  IF jsonb_array_length(v_changes) > 0 THEN
    INSERT INTO public.ac_bill_edit_logs (
      order_id, bill_no, edited_by, changes, snapshot_before, snapshot_after
    ) VALUES (
      p_order_id, nullif(v_order.bill_no, ''),
      coalesce(nullif(trim(p_edited_by), ''), 'unknown'), v_changes, NULL, NULL
    );
  END IF;

  RETURN jsonb_build_object('success', true, 'changes_count', jsonb_array_length(v_changes));
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_check_order_edit_eligibility(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_order_item_name_lines(UUID, JSONB, TEXT) TO authenticated;

-- Sanitized history for the Plan badge.  Snapshot columns and non-name edits
-- are intentionally not exposed to production users.
CREATE OR REPLACE FUNCTION public.rpc_get_plan_bill_name_edit_history(p_work_order_ids UUID[])
RETURNS TABLE (
  log_id UUID,
  work_order_id UUID,
  order_id UUID,
  bill_no TEXT,
  edited_by TEXT,
  edited_at TIMESTAMPTZ,
  changes JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    l.id,
    o.work_order_id,
    o.id,
    coalesce(l.bill_no, o.bill_no),
    l.edited_by,
    l.edited_at,
    filtered.changes
  FROM public.ac_bill_edit_logs l
  JOIN public.or_orders o ON o.id = l.order_id
  CROSS JOIN LATERAL (
    SELECT jsonb_agg(entry.value ORDER BY entry.ordinality) AS changes
    FROM jsonb_array_elements(coalesce(l.changes, '[]'::jsonb))
      WITH ORDINALITY AS entry(value, ordinality)
    WHERE coalesce(entry.value->>'field', '') ~ '^line_[123]:'
  ) filtered
  WHERE auth.uid() IS NOT NULL
    AND o.work_order_id = ANY(coalesce(p_work_order_ids, ARRAY[]::UUID[]))
    AND filtered.changes IS NOT NULL
  ORDER BY l.edited_at DESC;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_plan_bill_name_edit_history(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_get_plan_bill_name_edit_history(UUID[]) TO authenticated;

