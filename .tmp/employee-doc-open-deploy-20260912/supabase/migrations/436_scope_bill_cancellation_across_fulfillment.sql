-- Keep bill cancellation scoped to the bill/item that was approved.
-- Historical order rows remain for audit, while active fulfillment reads only
-- items whose cancellation_stock_action is NULL.

CREATE OR REPLACE FUNCTION rpc_execute_bill_cancellation(p_amendment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_amendment RECORD;
  v_order RECORD;
  v_snapshot_order JSONB;
  v_remove_ids UUID[];
  v_all_item_ids UUID[];
  v_target_item_ids UUID[];
  v_items_left INT := 0;
  v_active_orders_in_wo INT := 0;
  v_cancelled_wms INT := 0;
  v_new_total NUMERIC := 0;
  v_new_rev INT;
  v_is_partial BOOLEAN := false;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr') THEN
    RAISE EXCEPTION 'no permission to cancel bill (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT * INTO v_amendment
  FROM or_order_amendments
  WHERE id = p_amendment_id
  FOR UPDATE;
  IF v_amendment.id IS NULL THEN RAISE EXCEPTION 'amendment not found'; END IF;
  IF v_amendment.status = 'executed' THEN RAISE EXCEPTION 'amendment already executed'; END IF;

  SELECT * INTO v_order FROM or_orders WHERE id = v_amendment.order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'order not found'; END IF;

  SELECT row_to_json(o)::jsonb INTO v_snapshot_order
  FROM or_orders o WHERE o.id = v_order.id;

  SELECT array_agg(id) INTO v_all_item_ids
  FROM or_order_items WHERE order_id = v_order.id;

  IF v_amendment.changes_json IS NOT NULL AND v_amendment.changes_json ? 'remove_item_ids' THEN
    SELECT array_agg((x#>>'{}')::uuid)
    INTO v_remove_ids
    FROM jsonb_array_elements(v_amendment.changes_json->'remove_item_ids') x;
  END IF;

  v_is_partial := v_remove_ids IS NOT NULL AND array_length(v_remove_ids, 1) > 0;
  v_target_item_ids := CASE WHEN v_is_partial THEN v_remove_ids ELSE v_all_item_ids END;

  IF v_is_partial AND EXISTS (
    SELECT 1 FROM unnest(v_remove_ids) rid
    WHERE NOT EXISTS (
      SELECT 1 FROM or_order_items oi WHERE oi.id = rid AND oi.order_id = v_order.id
    )
  ) THEN
    RAISE EXCEPTION 'some remove_item_ids do not belong to this order';
  END IF;

  -- Notify only pickers whose rows actually belong to this bill/item.
  INSERT INTO wms_notifications (type, order_id, picker_id, status, is_read)
  SELECT DISTINCT 'ยกเลิกบิล', COALESCE(v_order.work_order_name, v_order.bill_no), w.assigned_to, 'unread', false
  FROM wms_orders w
  WHERE w.assigned_to IS NOT NULL
    AND w.status NOT IN ('cancelled', 'returned')
    AND (
      w.source_order_id = v_order.id
      AND (NOT v_is_partial OR w.source_order_item_id = ANY(v_target_item_ids))
      OR w.source_order_item_id = ANY(v_target_item_ids)
    );

  WITH changed AS (
    UPDATE wms_orders w
    SET status = 'cancelled', stock_action = NULL, end_time = COALESCE(w.end_time, NOW())
    WHERE w.status NOT IN ('cancelled', 'returned')
      AND (
        w.source_order_id = v_order.id
        AND (NOT v_is_partial OR w.source_order_item_id = ANY(v_target_item_ids))
        OR w.source_order_item_id = ANY(v_target_item_ids)
      )
    RETURNING 1
  ) SELECT COUNT(*) INTO v_cancelled_wms FROM changed;

  -- A completely unlinked legacy WO can only be cancelled safely when this is
  -- a full cancellation and no other active bill shares the work order.
  IF NOT v_is_partial AND v_order.work_order_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_active_orders_in_wo
    FROM or_orders o
    WHERE o.work_order_id = v_order.work_order_id
      AND o.id <> v_order.id
      AND COALESCE(o.status, '') NOT IN ('ยกเลิก', 'จัดส่งแล้ว');

    IF v_active_orders_in_wo = 0 THEN
      WITH legacy_changed AS (
        UPDATE wms_orders w
        SET status = 'cancelled', stock_action = NULL, end_time = COALESCE(w.end_time, NOW())
        WHERE w.work_order_id = v_order.work_order_id
          AND w.source_order_id IS NULL
          AND w.source_order_item_id IS NULL
          AND w.status NOT IN ('cancelled', 'returned')
        RETURNING 1
      )
      SELECT v_cancelled_wms + COUNT(*) INTO v_cancelled_wms FROM legacy_changed;
    END IF;
  END IF;

  UPDATE or_order_items
  SET cancellation_stock_action = 'pending'
  WHERE order_id = v_order.id AND id = ANY(v_target_item_ids);

  SELECT COUNT(*) INTO v_items_left
  FROM or_order_items
  WHERE order_id = v_order.id AND cancellation_stock_action IS NULL;

  IF v_items_left = 0 THEN
    UPDATE or_orders SET status = 'ยกเลิก', updated_at = NOW() WHERE id = v_order.id;
  ELSE
    SELECT COALESCE(SUM(COALESCE(quantity, 1) * COALESCE(unit_price, 0)), 0)
    INTO v_new_total
    FROM or_order_items
    WHERE order_id = v_order.id AND cancellation_stock_action IS NULL;
    UPDATE or_orders SET total_amount = v_new_total, updated_at = NOW() WHERE id = v_order.id;
  END IF;

  v_new_rev := COALESCE(v_order.revision_no, 0) + 1;
  INSERT INTO or_order_revisions (
    order_id, revision_no, change_source, change_source_id,
    snapshot_order, snapshot_items, created_by
  ) VALUES (
    v_order.id, v_new_rev, 'amendment', p_amendment_id,
    v_snapshot_order,
    COALESCE(v_amendment.items_before,
      (SELECT COALESCE(jsonb_agg(row_to_json(oi)::jsonb), '[]'::jsonb)
       FROM or_order_items oi WHERE oi.order_id = v_order.id)),
    (SELECT COALESCE(username, email) FROM us_users WHERE id = v_amendment.approved_by)
  );

  UPDATE or_orders SET revision_no = v_new_rev WHERE id = v_order.id;
  UPDATE or_order_amendments SET status = 'executed', executed_at = NOW() WHERE id = p_amendment_id;

  IF v_order.work_order_id IS NOT NULL THEN
    PERFORM fn_recompute_work_order_order_count(v_order.work_order_id);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'amendment_no', v_amendment.amendment_no,
    'bill_no', v_order.bill_no,
    'cancelled_wms_count', v_cancelled_wms,
    'revision_no', v_new_rev,
    'partial', v_items_left > 0
  );
END;
$$;

COMMENT ON FUNCTION rpc_execute_bill_cancellation(UUID) IS
'ยกเลิกเฉพาะ WMS rows ของบิล/รายการที่อนุมัติ และคงแถวสินค้าไว้เพื่อ Audit โดยตัดออกจาก fulfillment ด้วย cancellation_stock_action';
