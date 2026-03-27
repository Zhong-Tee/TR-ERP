-- 214: apply post-211 fixes for partial-cancel pending flow
-- - keep cancelled items visible in sales list until recall/waste decision
-- - add line-level cancellation_stock_action and deferred stock decision hooks

-- 211: defer stock reverse on bill cancellation until WMS action
--      and exclude recalled cancelled lines from product sales summary

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

    -- IMPORTANT: do NOT reverse stock here.
    -- WMS must choose recall / waste from notification modal.
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

  RETURN jsonb_build_object(
    'success', true,
    'amendment_no', v_amendment.amendment_no,
    'bill_no', v_order.bill_no,
    'cancelled_wms_count', v_cancelled_wms,
    'revision_no', v_new_rev
  );
END;
$$;

CREATE OR REPLACE FUNCTION fn_reverse_wms_stock(p_wms_order_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_movement       RECORD;
  v_consumption    RECORD;
  v_product_id     UUID;
  v_total_returned NUMERIC := 0;
  v_wms            RECORD;
  v_mult           NUMERIC := 1;
  v_reserved_qty   NUMERIC := 0;
BEGIN
  SELECT id, status, product_code, qty, stock_action, source_order_item_id, order_id
  INTO v_wms
  FROM wms_orders
  WHERE id = p_wms_order_id;

  IF v_wms.id IS NULL THEN
    RETURN 0;
  END IF;

  IF v_wms.stock_action IS NOT NULL THEN
    RETURN 0;
  END IF;

  SELECT sm.id, sm.product_id, sm.qty, sm.unit_cost
  INTO v_movement
  FROM inv_stock_movements sm
  WHERE sm.ref_type = 'wms_orders'
    AND sm.ref_id = p_wms_order_id
    AND sm.movement_type = 'pick'
  ORDER BY sm.created_at DESC
  LIMIT 1;

  IF v_movement.id IS NULL THEN
    -- picked but not correct yet: release reserved only
    SELECT id, COALESCE(unit_multiplier, 1)
    INTO v_product_id, v_mult
    FROM pr_products
    WHERE product_code = v_wms.product_code
    LIMIT 1;

    IF v_wms.status = 'picked' AND v_product_id IS NOT NULL THEN
      v_reserved_qty := COALESCE(v_wms.qty, 0) * COALESCE(v_mult, 1);
      UPDATE inv_stock_balances
      SET reserved = GREATEST(COALESCE(reserved, 0) - v_reserved_qty, 0)
      WHERE product_id = v_product_id;
    END IF;

    UPDATE wms_orders SET stock_action = 'recalled' WHERE id = p_wms_order_id;
    IF v_wms.source_order_item_id IS NOT NULL THEN
      UPDATE or_order_items
      SET cancellation_stock_action = 'recalled'
      WHERE id = v_wms.source_order_item_id;
    END IF;
    RETURN v_reserved_qty;
  END IF;

  v_product_id := v_movement.product_id;

  FOR v_consumption IN
    SELECT lc.lot_id, lc.qty
    FROM inv_lot_consumptions lc
    WHERE lc.movement_id = v_movement.id
  LOOP
    UPDATE inv_stock_lots
    SET qty_remaining = qty_remaining + v_consumption.qty
    WHERE id = v_consumption.lot_id;

    v_total_returned := v_total_returned + v_consumption.qty;
  END LOOP;

  INSERT INTO inv_stock_movements (
    product_id, movement_type, qty, ref_type, ref_id, note,
    unit_cost, total_cost
  ) VALUES (
    v_product_id, 'pick_reversal', v_total_returned,
    'wms_orders', p_wms_order_id,
    'Stock recall after cancelled bill',
    COALESCE(v_movement.unit_cost, 0),
    v_total_returned * COALESCE(v_movement.unit_cost, 0)
  );

  UPDATE inv_stock_balances
  SET on_hand = COALESCE(on_hand, 0) + v_total_returned
  WHERE product_id = v_product_id;

  PERFORM fn_recalc_product_landed_cost(v_product_id);

  UPDATE wms_orders SET stock_action = 'recalled' WHERE id = p_wms_order_id;

  IF v_wms.source_order_item_id IS NOT NULL THEN
    UPDATE or_order_items
    SET cancellation_stock_action = 'recalled'
    WHERE id = v_wms.source_order_item_id;
  ELSE
    UPDATE or_order_items oi
    SET cancellation_stock_action = 'recalled'
    FROM or_orders o, pr_products p
    WHERE oi.order_id = o.id
      AND p.id = oi.product_id
      AND oi.cancellation_stock_action = 'pending'
      AND trim(both FROM coalesce(o.work_order_name, '')) = trim(both FROM coalesce(v_wms.order_id, ''))
      AND upper(trim(both FROM coalesce(p.product_code::text, ''))) = upper(trim(both FROM coalesce(v_wms.product_code, '')));
  END IF;

  RETURN v_total_returned;
END;
$$;

CREATE OR REPLACE FUNCTION rpc_record_cancellation_waste(
  p_wms_order_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_movement      RECORD;
  v_product_id    UUID;
  v_qty           NUMERIC;
  v_avg_cost      NUMERIC;
  v_wms           RECORD;
  v_mult          NUMERIC := 1;
  v_reserved_qty  NUMERIC := 0;
BEGIN
  SELECT id, status, product_code, qty, stock_action, source_order_item_id, order_id
  INTO v_wms
  FROM wms_orders
  WHERE id = p_wms_order_id;

  IF v_wms.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'wms row not found');
  END IF;

  IF v_wms.stock_action IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'already processed');
  END IF;

  SELECT sm.id, sm.product_id, ABS(sm.qty) AS qty, sm.unit_cost
  INTO v_movement
  FROM inv_stock_movements sm
  WHERE sm.ref_type = 'wms_orders'
    AND sm.ref_id = p_wms_order_id
    AND sm.movement_type = 'pick'
  ORDER BY sm.created_at DESC
  LIMIT 1;

  IF v_movement.id IS NULL THEN
    -- picked but not correct yet: release reserved, then mark waste
    SELECT id, COALESCE(unit_multiplier, 1)
    INTO v_product_id, v_mult
    FROM pr_products
    WHERE product_code = v_wms.product_code
    LIMIT 1;

    IF v_wms.status = 'picked' AND v_product_id IS NOT NULL THEN
      v_reserved_qty := COALESCE(v_wms.qty, 0) * COALESCE(v_mult, 1);
      UPDATE inv_stock_balances
      SET reserved = GREATEST(COALESCE(reserved, 0) - v_reserved_qty, 0)
      WHERE product_id = v_product_id;
    END IF;

    UPDATE wms_orders SET stock_action = 'waste' WHERE id = p_wms_order_id;
    IF v_wms.source_order_item_id IS NOT NULL THEN
      UPDATE or_order_items
      SET cancellation_stock_action = 'waste'
      WHERE id = v_wms.source_order_item_id;
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'note', 'no pick movement; released reserved and marked as waste',
      'released_reserved_qty', v_reserved_qty
    );
  END IF;

  v_product_id := v_movement.product_id;
  v_qty := v_movement.qty;
  v_avg_cost := COALESCE(v_movement.unit_cost, 0);

  INSERT INTO inv_stock_movements (
    product_id, movement_type, qty, ref_type, ref_id, note,
    unit_cost, total_cost, created_by
  ) VALUES (
    v_product_id, 'waste', 0,
    'wms_orders', p_wms_order_id,
    'Waste mark from cancelled bill',
    v_avg_cost, 0,
    p_user_id
  );

  UPDATE wms_orders SET stock_action = 'waste' WHERE id = p_wms_order_id;

  IF v_wms.source_order_item_id IS NOT NULL THEN
    UPDATE or_order_items
    SET cancellation_stock_action = 'waste'
    WHERE id = v_wms.source_order_item_id;
  ELSE
    UPDATE or_order_items oi
    SET cancellation_stock_action = 'waste'
    FROM or_orders o, pr_products p
    WHERE oi.order_id = o.id
      AND p.id = oi.product_id
      AND oi.cancellation_stock_action = 'pending'
      AND trim(both FROM coalesce(o.work_order_name, '')) = trim(both FROM coalesce(v_wms.order_id, ''))
      AND upper(trim(both FROM coalesce(p.product_code::text, ''))) = upper(trim(both FROM coalesce(v_wms.product_code, '')));
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'product_id', v_product_id,
    'qty', v_qty,
    'action', 'waste'
  );
END;
$$;

CREATE OR REPLACE FUNCTION rpc_product_sales_summary(
  p_from_date DATE,
  p_to_date DATE
)
RETURNS TABLE(
  product_id UUID,
  product_code TEXT,
  product_name TEXT,
  product_type TEXT,
  total_qty NUMERIC,
  total_amount NUMERIC,
  order_count BIGINT
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT
    p.id            AS product_id,
    p.product_code,
    p.product_name,
    p.product_type,
    COALESCE(SUM(oi.quantity), 0)                  AS total_qty,
    COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS total_amount,
    COUNT(DISTINCT oi.order_id)                    AS order_count
  FROM or_order_items oi
  JOIN or_orders o ON o.id = oi.order_id
  JOIN pr_products p ON p.id = oi.product_id
  LEFT JOIN LATERAL (
    SELECT 1 AS hit
    FROM wms_orders w
    WHERE w.stock_action = 'recalled'
      AND w.status = 'cancelled'
      AND (
        w.source_order_item_id = oi.id
        OR (
          w.source_order_item_id IS NULL
          AND trim(both FROM coalesce(w.order_id, '')) = trim(both FROM coalesce(o.work_order_name, ''))
          AND upper(trim(both FROM coalesce(w.product_code, ''))) = upper(trim(both FROM coalesce(p.product_code::text, '')))
        )
      )
    LIMIT 1
  ) recalled_line ON true
  WHERE o.entry_date >= p_from_date
    AND o.entry_date <= p_to_date
    AND (o.status <> U&'\0E22\0E01\0E40\0E25\0E34\0E01' OR oi.cancellation_stock_action IN ('pending', 'waste'))
    AND oi.product_id IS NOT NULL
    AND COALESCE(oi.cancellation_stock_action, '') <> 'recalled'
    AND recalled_line.hit IS NULL
  GROUP BY p.id, p.product_code, p.product_name, p.product_type
  ORDER BY total_qty DESC;
$$;

GRANT EXECUTE ON FUNCTION rpc_product_sales_summary(DATE, DATE) TO authenticated;

COMMENT ON FUNCTION rpc_execute_bill_cancellation(UUID) IS
'Cancel bill/amendment execution now defers stock decision to WMS recall/waste actions.';

