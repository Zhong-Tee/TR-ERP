-- ═══════════════════════════════════════════════════════════════════════════
-- 187: ยกเลิกเฉพาะบางรายการในบิล (changes_json.remove_item_ids)
-- ═══════════════════════════════════════════════════════════════════════════

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
  v_product_id     UUID;
  v_mult           NUMERIC;
  v_actual         NUMERIC;
  v_items_left     INT;
  v_new_total      NUMERIC;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ยกเลิกบิล (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT * INTO v_amendment FROM or_order_amendments WHERE id = p_amendment_id;
  IF v_amendment.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขอยกเลิก'; END IF;

  SELECT * INTO v_order FROM or_orders WHERE id = v_amendment.order_id;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'ไม่พบออเดอร์'; END IF;

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
      RAISE EXCEPTION 'มีรายการที่ขอลบไม่เป็นของบิลนี้';
    END IF;

    IF v_wo <> '' THEN
      FOR v_wms IN
        SELECT id, status, product_code, qty, assigned_to, source_order_item_id
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
        SELECT id, COALESCE(unit_multiplier, 1)
        INTO v_product_id, v_mult
        FROM pr_products
        WHERE product_code = v_wms.product_code
        LIMIT 1;

        v_actual := COALESCE(v_wms.qty, 0) * COALESCE(v_mult, 1);

        IF v_wms.status = 'correct' AND v_product_id IS NOT NULL THEN
          PERFORM fn_reverse_wms_stock(v_wms.id);
        ELSIF v_wms.status = 'picked' AND v_product_id IS NOT NULL THEN
          UPDATE inv_stock_balances
            SET reserved = GREATEST(COALESCE(reserved, 0) - v_actual, 0)
            WHERE product_id = v_product_id;
        END IF;

        DELETE FROM wms_orders WHERE id = v_wms.id;
        v_cancelled_wms := v_cancelled_wms + 1;

        IF v_wms.assigned_to IS NOT NULL THEN
          INSERT INTO wms_notifications (type, order_id, picker_id, status, is_read)
          VALUES ('ยกเลิกบิล', v_order.work_order_name, v_wms.assigned_to, 'unread', false);
        END IF;
      END LOOP;
    END IF;

    DELETE FROM or_order_items WHERE id = ANY (v_remove_ids) AND order_id = v_amendment.order_id;

    SELECT COUNT(*) INTO v_items_left FROM or_order_items WHERE order_id = v_amendment.order_id;

    IF v_items_left = 0 THEN
      IF v_wo <> '' THEN
        FOR v_wms IN
          SELECT id, assigned_to FROM wms_orders
          WHERE trim(both FROM coalesce(order_id, '')) = v_wo
            AND status NOT IN ('cancelled', 'returned')
        LOOP
          UPDATE wms_orders SET status = 'cancelled' WHERE id = v_wms.id;
          v_cancelled_wms := v_cancelled_wms + 1;
          IF v_wms.assigned_to IS NOT NULL THEN
            INSERT INTO wms_notifications (type, order_id, picker_id, status, is_read)
            VALUES ('ยกเลิกบิล', v_order.work_order_name, v_wms.assigned_to, 'unread', false);
          END IF;
        END LOOP;
      END IF;

      UPDATE or_orders SET status = 'ยกเลิก', updated_at = NOW() WHERE id = v_amendment.order_id;
    ELSE
      SELECT COALESCE(SUM(coalesce(oi.quantity, 1) * coalesce(oi.unit_price, 0)), 0)
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
      UPDATE wms_orders SET status = 'cancelled' WHERE id = v_wms.id;
      v_cancelled_wms := v_cancelled_wms + 1;

      IF v_wms.assigned_to IS NOT NULL THEN
        INSERT INTO wms_notifications (type, order_id, picker_id, status, is_read)
        VALUES ('ยกเลิกบิล', v_order.work_order_name, v_wms.assigned_to, 'unread', false);
      END IF;
    END LOOP;
  END IF;

  UPDATE or_orders
  SET status = 'ยกเลิก', updated_at = NOW()
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

  RETURN jsonb_build_object(
    'success', true,
    'amendment_no', v_amendment.amendment_no,
    'bill_no', v_order.bill_no,
    'cancelled_wms_count', v_cancelled_wms,
    'revision_no', v_new_rev
  );
END;
$$;

