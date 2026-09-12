-- 224: Keep or_work_orders.order_count aligned with "active" bills (not ยกเลิก / not จัดส่งแล้ว)
-- - fn_recompute_work_order_order_count: single source of truth for the count formula
-- - rpc_execute_bill_cancellation: recompute after cancel
-- - rpc_plan_release_orders_to_workqueue_v2: v_remain uses same formula (void WO when no active bills remain)
-- - Backfill existing rows

CREATE OR REPLACE FUNCTION fn_recompute_work_order_order_count(p_work_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cnt int;
BEGIN
  IF p_work_order_id IS NULL THEN
    RETURN;
  END IF;

  SELECT COUNT(*)::int INTO v_cnt
  FROM or_orders o
  WHERE o.work_order_id = p_work_order_id
    AND COALESCE(o.status, '') NOT IN ('ยกเลิก', 'จัดส่งแล้ว');

  UPDATE or_work_orders
  SET
    order_count = v_cnt,
    plan_wo_modified = true
  WHERE id = p_work_order_id;
END;
$$;

COMMENT ON FUNCTION fn_recompute_work_order_order_count(uuid) IS
'ตั้ง order_count = จำนวนบิลที่ยังอยู่ในใบงานและไม่ใช่สถานะ ยกเลิก / จัดส่งแล้ว (สอดคล้องกับ Plan จัดการใบงาน โหมด active)';

-- --- rpc_execute_bill_cancellation: recompute after successful execution ---

CREATE OR REPLACE FUNCTION rpc_execute_bill_cancellation(p_amendment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role           TEXT;
  v_amendment      RECORD;
  v_order          RECORD;
  v_wms            RECORD;
  v_cancelled_wms  INT := 0;
  v_snapshot_order JSONB;
  v_new_rev        INT;
  v_remove_ids     UUID[];
  v_wo             TEXT;
  v_items_left     INT;
  v_new_total      NUMERIC;
  v_cancel_type    TEXT := U&'\0E22\0E01\0E40\0E25\0E34\0E01\0E1A\0E34\0E25';
  v_cancel_status  TEXT := U&'\0E22\0E01\0E40\0E25\0E34\0E01';
BEGIN
  ALTER TABLE or_order_items
    ADD COLUMN IF NOT EXISTS cancellation_stock_action TEXT;

  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr') THEN
    RAISE EXCEPTION 'no permission to cancel bill (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT * INTO v_amendment FROM or_order_amendments WHERE id = p_amendment_id;
  IF v_amendment.id IS NULL THEN RAISE EXCEPTION 'amendment not found'; END IF;

  SELECT * INTO v_order FROM or_orders WHERE id = v_amendment.order_id;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'order not found'; END IF;

  SELECT row_to_json(o)::jsonb INTO v_snapshot_order
  FROM or_orders o WHERE o.id = v_amendment.order_id;

  v_wo := trim(both FROM coalesce(v_order.work_order_name, ''));

  IF v_amendment.changes_json IS NOT NULL AND v_amendment.changes_json ? 'remove_item_ids' THEN
    SELECT array_agg((x#>>'{}')::uuid)
    INTO v_remove_ids
    FROM jsonb_array_elements(v_amendment.changes_json->'remove_item_ids') x;
  END IF;

  IF v_remove_ids IS NOT NULL AND array_length(v_remove_ids, 1) > 0 THEN
    IF EXISTS (
      SELECT 1 FROM unnest(v_remove_ids) rid
      WHERE NOT EXISTS (
        SELECT 1 FROM or_order_items oi
        WHERE oi.id = rid AND oi.order_id = v_amendment.order_id
      )
    ) THEN
      RAISE EXCEPTION 'some remove_item_ids do not belong to this order';
    END IF;

    IF v_wo <> '' THEN
      FOR v_wms IN
        SELECT id, assigned_to
        FROM wms_orders
        WHERE trim(both FROM coalesce(order_id, '')) = v_wo
          AND (
            source_order_item_id = ANY (v_remove_ids)
            OR (
              source_order_item_id IS NULL
              AND product_code IN (
                SELECT trim(both FROM coalesce(p.product_code::text, ''))
                FROM or_order_items oi
                JOIN pr_products p ON p.id = oi.product_id
                WHERE oi.id = ANY (v_remove_ids)
              )
            )
          )
          AND status NOT IN ('cancelled', 'returned')
      LOOP
        UPDATE wms_orders
        SET status = 'cancelled', stock_action = NULL
        WHERE id = v_wms.id;

        v_cancelled_wms := v_cancelled_wms + 1;

        IF v_wms.assigned_to IS NOT NULL THEN
          INSERT INTO wms_notifications (type, order_id, picker_id, status, is_read)
          VALUES (v_cancel_type, v_order.work_order_name, v_wms.assigned_to, 'unread', false);
        END IF;
      END LOOP;
    END IF;

    UPDATE or_order_items
    SET cancellation_stock_action = 'pending'
    WHERE id = ANY (v_remove_ids)
      AND order_id = v_amendment.order_id;

    SELECT COUNT(*) INTO v_items_left
    FROM or_order_items
    WHERE order_id = v_amendment.order_id
      AND cancellation_stock_action IS NULL;

    IF v_items_left = 0 THEN
      IF v_wo <> '' THEN
        FOR v_wms IN
          SELECT id, assigned_to FROM wms_orders
          WHERE trim(both FROM coalesce(order_id, '')) = v_wo
            AND status NOT IN ('cancelled', 'returned')
        LOOP
          UPDATE wms_orders
          SET status = 'cancelled', stock_action = NULL
          WHERE id = v_wms.id;

          v_cancelled_wms := v_cancelled_wms + 1;
          IF v_wms.assigned_to IS NOT NULL THEN
            INSERT INTO wms_notifications (type, order_id, picker_id, status, is_read)
            VALUES (v_cancel_type, v_order.work_order_name, v_wms.assigned_to, 'unread', false);
          END IF;
        END LOOP;
      END IF;

      UPDATE or_orders SET status = v_cancel_status, updated_at = NOW() WHERE id = v_amendment.order_id;
    ELSE
      SELECT COALESCE(SUM(
        CASE
          WHEN oi.cancellation_stock_action IS NULL THEN coalesce(oi.quantity, 1) * coalesce(oi.unit_price, 0)
          ELSE 0
        END
      ), 0)
      INTO v_new_total
      FROM or_order_items oi
      WHERE oi.order_id = v_amendment.order_id;

      UPDATE or_orders SET total_amount = v_new_total, updated_at = NOW() WHERE id = v_amendment.order_id;
    END IF;

    v_new_rev := COALESCE(v_order.revision_no, 0) + 1;

    INSERT INTO or_order_revisions (
      order_id, revision_no, change_source, change_source_id,
      snapshot_order, snapshot_items, created_by
    ) VALUES (
      v_amendment.order_id, v_new_rev, 'amendment', p_amendment_id,
      v_snapshot_order,
      v_amendment.items_before,
      (SELECT COALESCE(username, email) FROM us_users WHERE id = v_amendment.approved_by)
    );

    UPDATE or_orders SET revision_no = v_new_rev WHERE id = v_amendment.order_id;

    UPDATE or_order_amendments
    SET status = 'executed', executed_at = NOW()
    WHERE id = p_amendment_id;

    IF v_order.work_order_id IS NOT NULL THEN
      PERFORM fn_recompute_work_order_order_count(v_order.work_order_id);
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'amendment_no', v_amendment.amendment_no,
      'bill_no', v_order.bill_no,
      'cancelled_wms_count', v_cancelled_wms,
      'revision_no', v_new_rev,
      'partial', true
    );
  END IF;

  IF v_wo <> '' THEN
    FOR v_wms IN
      SELECT id, assigned_to
      FROM wms_orders
      WHERE order_id = v_order.work_order_name
        AND status NOT IN ('cancelled')
    LOOP
      UPDATE wms_orders
      SET status = 'cancelled', stock_action = NULL
      WHERE id = v_wms.id;

      v_cancelled_wms := v_cancelled_wms + 1;

      IF v_wms.assigned_to IS NOT NULL THEN
        INSERT INTO wms_notifications (type, order_id, picker_id, status, is_read)
        VALUES (v_cancel_type, v_order.work_order_name, v_wms.assigned_to, 'unread', false);
      END IF;
    END LOOP;
  END IF;

  UPDATE or_order_items
  SET cancellation_stock_action = 'pending'
  WHERE order_id = v_amendment.order_id;

  UPDATE or_orders
  SET status = v_cancel_status, updated_at = NOW()
  WHERE id = v_amendment.order_id;

  v_new_rev := COALESCE(v_order.revision_no, 0) + 1;

  INSERT INTO or_order_revisions (
    order_id, revision_no, change_source, change_source_id,
    snapshot_order, snapshot_items, created_by
  ) VALUES (
    v_amendment.order_id, v_new_rev, 'amendment', p_amendment_id,
    v_snapshot_order,
    (SELECT COALESCE(jsonb_agg(row_to_json(oi)::jsonb), '[]'::jsonb)
     FROM or_order_items oi WHERE oi.order_id = v_amendment.order_id),
    (SELECT COALESCE(username, email) FROM us_users WHERE id = v_amendment.approved_by)
  );

  UPDATE or_orders SET revision_no = v_new_rev WHERE id = v_amendment.order_id;

  UPDATE or_order_amendments
  SET status = 'executed', executed_at = NOW()
  WHERE id = p_amendment_id;

  IF v_order.work_order_id IS NOT NULL THEN
    PERFORM fn_recompute_work_order_order_count(v_order.work_order_id);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'amendment_no', v_amendment.amendment_no,
    'bill_no', v_order.bill_no,
    'cancelled_wms_count', v_cancelled_wms,
    'revision_no', v_new_rev
  );
END;
$$;

-- --- rpc_plan_release_orders_to_workqueue_v2: same v_remain semantics ---

CREATE OR REPLACE FUNCTION rpc_plan_release_orders_to_workqueue_v2(
  p_work_order_id UUID,
  p_order_ids     UUID[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role     TEXT;
  v_wo_name  TEXT;
  v_uid      UUID;
  v_remain   INT;
  v_legacy   BOOLEAN;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'store', 'manager', 'production', 'admin-tr', 'admin_qc') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ย้ายบิลไปใบสั่งงาน';
  END IF;

  IF p_work_order_id IS NULL OR p_order_ids IS NULL OR array_length(p_order_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'ข้อมูลไม่ครบ');
  END IF;

  SELECT work_order_name INTO v_wo_name
  FROM or_work_orders
  WHERE id = p_work_order_id;

  IF v_wo_name IS NULL OR trim(v_wo_name) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'ไม่พบใบงาน');
  END IF;

  FOREACH v_uid IN ARRAY p_order_ids
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM or_orders o
      WHERE o.id = v_uid AND o.work_order_id = p_work_order_id
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'บิลไม่อยู่ในใบงานนี้');
    END IF;
  END LOOP;

  SELECT EXISTS (
    SELECT 1 FROM wms_orders w
    WHERE w.work_order_id = p_work_order_id
      AND w.source_order_id IS NULL
      AND w.status NOT IN ('cancelled', 'returned')
  ) INTO v_legacy;

  IF v_legacy THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'wms_legacy',
      'error', 'ใบงานนี้ได้มีการเบิกสินค้าไปแล้ว ติดต่อหัวหน้างานเพื่อทำการยกเลิกบิล หากต้องการเปลี่ยนแปลง'
    );
  END IF;

  UPDATE wms_orders w
  SET plan_line_released = true
  WHERE w.work_order_id = p_work_order_id
    AND w.source_order_id = ANY (p_order_ids)
    AND w.status IN ('picked', 'correct', 'system_complete')
    AND w.status NOT IN ('cancelled', 'returned');

  DELETE FROM wms_orders w
  WHERE w.work_order_id = p_work_order_id
    AND w.source_order_id = ANY (p_order_ids)
    AND w.status = 'pending';

  UPDATE or_orders o
  SET
    work_order_id = NULL,
    work_order_name = NULL,
    status = 'ใบสั่งงาน'::text,
    plan_released_from_work_order = v_wo_name,
    plan_released_from_work_order_id = p_work_order_id,
    plan_released_at = NOW(),
    updated_at = NOW()
  WHERE o.id = ANY (p_order_ids)
    AND o.work_order_id = p_work_order_id;

  SELECT COUNT(*) INTO v_remain
  FROM or_orders o
  WHERE o.work_order_id = p_work_order_id
    AND COALESCE(o.status, '') NOT IN (
      U&'\0E22\0E01\0E40\0E25\0E34\0E01',
      U&'\0E08\0E31\0E14\0E2A\0E48\0E07\0E41\0E25\0E49\0E27'
    );

  IF v_remain = 0 THEN
    DELETE FROM wms_orders w
    WHERE w.work_order_id = p_work_order_id
      AND NOT (
        w.plan_line_released = true
        AND w.status IN ('picked', 'correct', 'system_complete')
      );

    IF EXISTS (
      SELECT 1
      FROM plan_jobs pj
      WHERE pj.work_order_id = p_work_order_id
        AND fn_plan_job_has_any_track_start(pj.name)
    ) THEN
      UPDATE plan_jobs
      SET
        qty = fn_plan_qty_json_for_work_order(v_wo_name),
        is_production_voided = true
      WHERE work_order_id = p_work_order_id;
    ELSE
      DELETE FROM plan_jobs WHERE work_order_id = p_work_order_id;
    END IF;

    UPDATE or_work_orders
    SET
      status = 'ยกเลิก',
      order_count = 0,
      plan_wo_modified = true
    WHERE id = p_work_order_id;
  ELSE
    UPDATE or_work_orders wo
    SET
      order_count = v_remain,
      plan_wo_modified = true
    WHERE wo.id = p_work_order_id;

    UPDATE plan_jobs pj
    SET qty = fn_plan_qty_json_for_work_order(v_wo_name)
    WHERE pj.work_order_id = p_work_order_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'work_order_id', p_work_order_id,
    'work_order_name', v_wo_name,
    'remaining_bills', v_remain
  );
END;
$$;

-- Backfill order_count for all work orders that still have linked orders
UPDATE or_work_orders wo
SET
  order_count = sub.cnt,
  plan_wo_modified = true
FROM (
  SELECT
    o.work_order_id AS wid,
    COUNT(*)::int AS cnt
  FROM or_orders o
  WHERE o.work_order_id IS NOT NULL
    AND COALESCE(o.status, '') NOT IN (
      U&'\0E22\0E01\0E40\0E25\0E34\0E01',
      U&'\0E08\0E31\0E14\0E2A\0E48\0E07\0E41\0E25\0E49\0E27'
    )
  GROUP BY o.work_order_id
) sub
WHERE wo.id = sub.wid
  AND (wo.order_count IS DISTINCT FROM sub.cnt);
