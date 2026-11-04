-- Separate "not picked / no stock impact" from a real stock recall.
-- Picker out-of-stock reports stay in wms_notifications for warehouse review;
-- this migration only resolves the cancelled bill's stock consequence.

BEGIN;

ALTER TABLE public.wms_orders
  ADD COLUMN IF NOT EXISTS status_before_cancel TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES public.us_users(id);

ALTER TABLE public.plan_jobs
  ADD COLUMN IF NOT EXISTS production_voided_at TIMESTAMPTZ;

ALTER TABLE public.wms_orders
  DROP CONSTRAINT IF EXISTS wms_orders_stock_action_check;

ALTER TABLE public.wms_orders
  ADD CONSTRAINT wms_orders_stock_action_check
  CHECK (stock_action IS NULL OR stock_action IN ('not_picked', 'recalled', 'waste'));

COMMENT ON COLUMN public.wms_orders.status_before_cancel IS
  'WMS status immediately before cancellation; preserves whether stock was untouched, reserved or deducted.';
COMMENT ON COLUMN public.wms_orders.stock_action IS
  'Cancellation stock result: not_picked=no stock impact, recalled=physical/ledger return, waste=not returned.';
COMMENT ON COLUMN public.plan_jobs.production_voided_at IS
  'Time production was stopped because every active item in the work order was cancelled.';

CREATE OR REPLACE FUNCTION public.trg_guard_cancelled_stock_action_roles()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_jwt_role TEXT;
  v_allowed BOOLEAN := FALSE;
BEGIN
  IF NEW.stock_action IS NOT DISTINCT FROM OLD.stock_action THEN RETURN NEW; END IF;
  IF NEW.stock_action IN ('not_picked', 'recalled', 'waste') THEN
    v_jwt_role := COALESCE(current_setting('request.jwt.claim.role', TRUE), '');
    IF v_jwt_role = 'service_role' THEN RETURN NEW; END IF;
    SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
    v_allowed := COALESCE(v_role, '') IN ('superadmin', 'admin', 'store')
      OR public.is_current_wms_store_backup()
      OR (NEW.stock_action = 'not_picked' AND COALESCE(v_role, '') = 'admin-tr');
    IF NOT v_allowed THEN
      RAISE EXCEPTION 'ไม่มีสิทธิ์ปรับผลสต๊อคบิลยกเลิก (role: %)', COALESCE(v_role, 'unknown')
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trg_guard_cancelled_stock_action_roles() IS
  'Protects not_picked/recalled/waste cancellation decisions; admin-tr may only receive automatic not_picked.';

CREATE OR REPLACE FUNCTION public.trg_capture_wms_cancellation_origin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    NEW.status_before_cancel := COALESCE(NEW.status_before_cancel, OLD.status);
    NEW.cancelled_at := COALESCE(NEW.cancelled_at, NOW());
    NEW.cancelled_by := COALESCE(NEW.cancelled_by, auth.uid());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_aa_capture_wms_cancellation_origin ON public.wms_orders;
CREATE TRIGGER trg_aa_capture_wms_cancellation_origin
BEFORE UPDATE OF status ON public.wms_orders
FOR EACH ROW
EXECUTE FUNCTION public.trg_capture_wms_cancellation_origin();

CREATE OR REPLACE FUNCTION public.trg_stamp_voided_plan_job()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_voided_at TIMESTAMPTZ;
  v_dept TEXT;
  v_has_started BOOLEAN;
BEGIN
  IF NEW.is_production_voided = TRUE
     AND COALESCE(OLD.is_production_voided, FALSE) = FALSE THEN
    v_voided_at := COALESCE(NEW.production_voided_at, NOW());
    NEW.production_voided_at := v_voided_at;
    NEW.tracks := COALESCE(NEW.tracks, '{}'::JSONB);

    FOREACH v_dept IN ARRAY ARRAY['QC', 'PACK'] LOOP
      SELECT EXISTS (
        SELECT 1
        FROM jsonb_each(COALESCE(NEW.tracks -> v_dept, '{}'::JSONB)) AS step
        WHERE NULLIF(step.value ->> 'start', '') IS NOT NULL
      ) INTO v_has_started;

      IF v_has_started THEN
        NEW.tracks := jsonb_set(
          NEW.tracks,
          ARRAY[v_dept, 'ยกเลิก'],
          jsonb_build_object('start', NULL, 'end', to_jsonb(v_voided_at)),
          TRUE
        );
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_voided_plan_job ON public.plan_jobs;
CREATE TRIGGER trg_stamp_voided_plan_job
BEFORE UPDATE OF is_production_voided ON public.plan_jobs
FOR EACH ROW
EXECUTE FUNCTION public.trg_stamp_voided_plan_job();

CREATE OR REPLACE FUNCTION public.rpc_resolve_cancelled_wms(
  p_wms_order_id UUID,
  p_action TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_wms public.wms_orders%ROWTYPE;
  v_product_id UUID;
  v_stock_qty NUMERIC := 0;
  v_net_deducted NUMERIC := 0;
  v_movement_id UUID;
  v_result JSONB;
  v_on_hand NUMERIC := 0;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์จัดการสต๊อกรายการยกเลิก';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('not_picked', 'recall', 'waste') THEN
    RAISE EXCEPTION 'วิธีจัดการไม่ถูกต้อง: %', p_action;
  END IF;

  SELECT * INTO v_wms
  FROM public.wms_orders
  WHERE id = p_wms_order_id
  FOR UPDATE;

  IF v_wms.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการ WMS'; END IF;
  IF v_wms.status <> 'cancelled' THEN RAISE EXCEPTION 'รายการนี้ไม่ได้อยู่ในสถานะยกเลิก'; END IF;
  IF v_wms.stock_action IS NOT NULL THEN
    RETURN jsonb_build_object('success', TRUE, 'already_processed', TRUE, 'action', v_wms.stock_action);
  END IF;

  SELECT COALESCE(SUM(-m.qty) FILTER (
    WHERE m.movement_type IN ('pick', 'pick_reversal')
  ), 0)
  INTO v_net_deducted
  FROM public.inv_stock_movements m
  WHERE m.ref_type = 'wms_orders' AND m.ref_id = v_wms.id;
  v_net_deducted := GREATEST(v_net_deducted, 0);

  SELECT p.id INTO v_product_id
  FROM public.pr_products p
  WHERE UPPER(BTRIM(COALESCE(p.product_code::TEXT, ''))) = UPPER(BTRIM(COALESCE(v_wms.product_code, '')))
  LIMIT 1;
  v_stock_qty := COALESCE(v_wms.qty, 0);

  IF p_action = 'not_picked' THEN
    IF v_net_deducted > 0 OR COALESCE(v_wms.status_before_cancel, '') IN ('picked', 'correct') THEN
      RAISE EXCEPTION 'รายการนี้เคยหยิบหรือมีการตัดสต๊อกแล้ว กรุณาเลือกคืนสต๊อกหรือของเสีย';
    END IF;
    UPDATE public.wms_orders SET stock_action = 'not_picked' WHERE id = v_wms.id;

  ELSIF p_action = 'recall' THEN
    IF v_net_deducted > 0 THEN
      PERFORM public.fn_reverse_wms_stock(v_wms.id);
    ELSIF v_wms.status_before_cancel = 'picked' THEN
      IF v_product_id IS NULL THEN RAISE EXCEPTION 'ไม่พบสินค้าในคลัง'; END IF;
      PERFORM 1 FROM public.inv_stock_balances WHERE product_id = v_product_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบยอดคงเหลือของสินค้าในคลัง'; END IF;
      UPDATE public.inv_stock_balances
      SET reserved = GREATEST(COALESCE(reserved, 0) - v_stock_qty, 0), updated_at = NOW()
      WHERE product_id = v_product_id;
      UPDATE public.wms_orders SET stock_action = 'recalled' WHERE id = v_wms.id;
    ELSE
      RAISE EXCEPTION 'รายการนี้ไม่มีการหยิบหรือตัดสต๊อก กรุณาเลือก “ไม่ได้หยิบ”';
    END IF;

  ELSE
    IF v_net_deducted > 0 THEN
      SELECT public.rpc_record_cancellation_waste(v_wms.id, auth.uid()) INTO v_result;
    ELSIF v_wms.status_before_cancel = 'picked' THEN
      IF v_product_id IS NULL THEN RAISE EXCEPTION 'ไม่พบสินค้าในคลัง'; END IF;
      SELECT COALESCE(on_hand, 0) INTO v_on_hand
      FROM public.inv_stock_balances
      WHERE product_id = v_product_id
      FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบยอดคงเหลือของสินค้าในคลัง'; END IF;
      IF v_on_hand < v_stock_qty THEN
        RAISE EXCEPTION 'ยอดคงเหลือไม่พอสำหรับบันทึกของเสีย ขาด %', v_stock_qty - v_on_hand;
      END IF;
      INSERT INTO public.inv_stock_movements(
        product_id, movement_type, qty, ref_type, ref_id, note, created_by
      ) VALUES (
        v_product_id, 'waste', -v_stock_qty, 'wms_orders', v_wms.id,
        'ของเสียจากบิลยกเลิกหลังหยิบแต่ก่อนตรวจหยิบถูก', auth.uid()
      ) RETURNING id INTO v_movement_id;
      PERFORM public.fn_consume_stock_fifo(v_product_id, v_stock_qty, v_movement_id);
      UPDATE public.inv_stock_balances
      SET on_hand = COALESCE(on_hand, 0) - v_stock_qty,
          reserved = GREATEST(COALESCE(reserved, 0) - v_stock_qty, 0),
          updated_at = NOW()
      WHERE product_id = v_product_id;
      PERFORM public.fn_recalc_product_landed_cost(v_product_id);
      UPDATE public.wms_orders SET stock_action = 'waste' WHERE id = v_wms.id;
    ELSE
      RAISE EXCEPTION 'รายการนี้ไม่มีการหยิบหรือตัดสต๊อก กรุณาเลือก “ไม่ได้หยิบ”';
    END IF;
  END IF;

  IF v_wms.source_order_item_id IS NOT NULL THEN
    UPDATE public.or_order_items
    SET cancellation_stock_action = CASE WHEN p_action = 'recall' THEN 'recalled' ELSE p_action END
    WHERE id = v_wms.source_order_item_id;
  ELSE
    UPDATE public.or_order_items oi
    SET cancellation_stock_action = CASE WHEN p_action = 'recall' THEN 'recalled' ELSE p_action END
    FROM public.or_orders o, public.pr_products p
    WHERE oi.order_id = o.id
      AND p.id = oi.product_id
      AND oi.cancellation_stock_action = 'pending'
      AND BTRIM(COALESCE(o.work_order_name, '')) = BTRIM(COALESCE(v_wms.order_id, ''))
      AND UPPER(BTRIM(COALESCE(p.product_code::TEXT, ''))) = UPPER(BTRIM(COALESCE(v_wms.product_code, '')));
  END IF;

  RETURN jsonb_build_object(
    'success', TRUE,
    'action', CASE WHEN p_action = 'recall' THEN 'recalled' ELSE p_action END,
    'net_deducted_qty', v_net_deducted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_resolve_cancelled_wms(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_resolve_cancelled_wms(UUID, TEXT) TO authenticated;

-- Override cancellation execution so the original WMS status is retained and
-- untouched pending/out-of-stock rows are resolved as not_picked automatically.
CREATE OR REPLACE FUNCTION public.rpc_execute_bill_cancellation(p_amendment_id UUID)
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
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr') THEN
    RAISE EXCEPTION 'no permission to cancel bill (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT * INTO v_amendment FROM public.or_order_amendments WHERE id = p_amendment_id FOR UPDATE;
  IF v_amendment.id IS NULL THEN RAISE EXCEPTION 'amendment not found'; END IF;
  IF v_amendment.status = 'executed' THEN RAISE EXCEPTION 'amendment already executed'; END IF;

  SELECT * INTO v_order FROM public.or_orders WHERE id = v_amendment.order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'order not found'; END IF;
  SELECT row_to_json(o)::JSONB INTO v_snapshot_order FROM public.or_orders o WHERE o.id = v_order.id;
  SELECT array_agg(id) INTO v_all_item_ids FROM public.or_order_items WHERE order_id = v_order.id;

  IF v_amendment.changes_json IS NOT NULL AND v_amendment.changes_json ? 'remove_item_ids' THEN
    SELECT array_agg((x#>>'{}')::UUID) INTO v_remove_ids
    FROM jsonb_array_elements(v_amendment.changes_json->'remove_item_ids') x;
  END IF;
  v_is_partial := v_remove_ids IS NOT NULL AND array_length(v_remove_ids, 1) > 0;
  v_target_item_ids := CASE WHEN v_is_partial THEN v_remove_ids ELSE v_all_item_ids END;

  IF v_is_partial AND EXISTS (
    SELECT 1 FROM unnest(v_remove_ids) rid
    WHERE NOT EXISTS (SELECT 1 FROM public.or_order_items oi WHERE oi.id = rid AND oi.order_id = v_order.id)
  ) THEN RAISE EXCEPTION 'some remove_item_ids do not belong to this order'; END IF;

  INSERT INTO public.wms_notifications(type, order_id, picker_id, status, is_read)
  SELECT DISTINCT 'ยกเลิกบิล', COALESCE(v_order.work_order_name, v_order.bill_no), w.assigned_to, 'unread', FALSE
  FROM public.wms_orders w
  WHERE w.assigned_to IS NOT NULL
    AND w.status NOT IN ('cancelled', 'returned')
    AND ((w.source_order_id = v_order.id AND (NOT v_is_partial OR w.source_order_item_id = ANY(v_target_item_ids)))
      OR w.source_order_item_id = ANY(v_target_item_ids));

  WITH changed AS (
    UPDATE public.wms_orders w
    SET status_before_cancel = COALESCE(w.status_before_cancel, w.status),
        cancelled_at = COALESCE(w.cancelled_at, NOW()),
        cancelled_by = COALESCE(w.cancelled_by, auth.uid()),
        stock_action = CASE
          WHEN w.status IN ('pending', 'out_of_stock')
           AND NOT EXISTS (
             SELECT 1 FROM public.inv_stock_movements m
             WHERE m.ref_type = 'wms_orders' AND m.ref_id = w.id AND m.movement_type = 'pick'
           ) THEN 'not_picked'
          ELSE NULL
        END,
        status = 'cancelled',
        end_time = COALESCE(w.end_time, NOW())
    WHERE w.status NOT IN ('cancelled', 'returned')
      AND ((w.source_order_id = v_order.id AND (NOT v_is_partial OR w.source_order_item_id = ANY(v_target_item_ids)))
        OR w.source_order_item_id = ANY(v_target_item_ids))
    RETURNING 1
  ) SELECT COUNT(*) INTO v_cancelled_wms FROM changed;

  IF NOT v_is_partial AND v_order.work_order_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_active_orders_in_wo
    FROM public.or_orders o
    WHERE o.work_order_id = v_order.work_order_id AND o.id <> v_order.id
      AND COALESCE(o.status, '') NOT IN ('ยกเลิก', 'จัดส่งแล้ว');

    IF v_active_orders_in_wo = 0 THEN
      WITH legacy_changed AS (
        UPDATE public.wms_orders w
        SET status_before_cancel = COALESCE(w.status_before_cancel, w.status),
            cancelled_at = COALESCE(w.cancelled_at, NOW()),
            cancelled_by = COALESCE(w.cancelled_by, auth.uid()),
            stock_action = CASE
              WHEN w.status IN ('pending', 'out_of_stock')
               AND NOT EXISTS (
                 SELECT 1 FROM public.inv_stock_movements m
                 WHERE m.ref_type = 'wms_orders' AND m.ref_id = w.id AND m.movement_type = 'pick'
               ) THEN 'not_picked'
              ELSE NULL
            END,
            status = 'cancelled', end_time = COALESCE(w.end_time, NOW())
        WHERE w.work_order_id = v_order.work_order_id
          AND w.source_order_id IS NULL AND w.source_order_item_id IS NULL
          AND w.status NOT IN ('cancelled', 'returned')
        RETURNING 1
      ) SELECT v_cancelled_wms + COUNT(*) INTO v_cancelled_wms FROM legacy_changed;
    END IF;
  END IF;

  UPDATE public.or_order_items
  SET cancellation_stock_action = 'pending'
  WHERE order_id = v_order.id AND id = ANY(v_target_item_ids);

  UPDATE public.or_order_items oi
  SET cancellation_stock_action = 'not_picked'
  WHERE oi.order_id = v_order.id AND oi.id = ANY(v_target_item_ids)
    AND (
      (
        EXISTS (SELECT 1 FROM public.wms_orders w WHERE w.source_order_item_id = oi.id)
        AND NOT EXISTS (
          SELECT 1 FROM public.wms_orders w
          WHERE w.source_order_item_id = oi.id AND COALESCE(w.stock_action, '') <> 'not_picked'
        )
      )
      OR NOT EXISTS (
        SELECT 1 FROM public.wms_orders w
        WHERE w.source_order_id = v_order.id
           OR w.work_order_id = v_order.work_order_id
           OR BTRIM(COALESCE(w.order_id, '')) = BTRIM(COALESCE(v_order.work_order_name, ''))
      )
    );

  SELECT COUNT(*) INTO v_items_left
  FROM public.or_order_items
  WHERE order_id = v_order.id AND cancellation_stock_action IS NULL;

  IF v_items_left = 0 THEN
    UPDATE public.or_orders SET status = 'ยกเลิก', updated_at = NOW() WHERE id = v_order.id;
  ELSE
    SELECT COALESCE(SUM(COALESCE(quantity, 1) * COALESCE(unit_price, 0)), 0)
    INTO v_new_total FROM public.or_order_items
    WHERE order_id = v_order.id AND cancellation_stock_action IS NULL;
    UPDATE public.or_orders SET total_amount = v_new_total, updated_at = NOW() WHERE id = v_order.id;
  END IF;

  v_new_rev := COALESCE(v_order.revision_no, 0) + 1;
  INSERT INTO public.or_order_revisions(
    order_id, revision_no, change_source, change_source_id, snapshot_order, snapshot_items, created_by
  ) VALUES (
    v_order.id, v_new_rev, 'amendment', p_amendment_id, v_snapshot_order,
    COALESCE(v_amendment.items_before,
      (SELECT COALESCE(jsonb_agg(row_to_json(oi)::JSONB), '[]'::JSONB)
       FROM public.or_order_items oi WHERE oi.order_id = v_order.id)),
    (SELECT COALESCE(username, email) FROM public.us_users WHERE id = v_amendment.approved_by)
  );

  UPDATE public.or_orders SET revision_no = v_new_rev WHERE id = v_order.id;
  UPDATE public.or_order_amendments SET status = 'executed', executed_at = NOW() WHERE id = p_amendment_id;
  IF v_order.work_order_id IS NOT NULL THEN
    PERFORM public.fn_recompute_work_order_order_count(v_order.work_order_id);
  END IF;

  RETURN jsonb_build_object(
    'success', TRUE, 'amendment_no', v_amendment.amendment_no, 'bill_no', v_order.bill_no,
    'cancelled_wms_count', v_cancelled_wms, 'revision_no', v_new_rev, 'partial', v_items_left > 0
  );
END;
$$;

-- Repair only rows that can be proven safe: the picker explicitly reported
-- out_of_stock and no pick movement exists. The product-missing notification
-- is intentionally left untouched for warehouse investigation.
UPDATE public.wms_orders w
SET status_before_cancel = 'out_of_stock',
    stock_action = 'not_picked',
    cancelled_at = COALESCE(w.cancelled_at, w.end_time, w.stock_action_at, NOW())
WHERE w.status = 'cancelled'
  AND w.stock_action = 'recalled'
  AND EXISTS (
    SELECT 1 FROM public.wms_notifications n
    WHERE n.type = 'สินค้าหมด (X)'
      AND BTRIM(COALESCE(n.order_id, '')) = BTRIM(COALESCE(w.order_id, ''))
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.inv_stock_movements m
    WHERE m.ref_type = 'wms_orders' AND m.ref_id = w.id AND m.movement_type = 'pick'
  );

UPDATE public.or_order_items oi
SET cancellation_stock_action = 'not_picked'
FROM public.wms_orders w
WHERE w.source_order_item_id = oi.id
  AND w.stock_action = 'not_picked'
  AND oi.cancellation_stock_action IN ('pending', 'recalled');

UPDATE public.plan_jobs
SET production_voided_at = COALESCE(
  production_voided_at,
  (
    SELECT MAX(COALESCE(w.cancelled_at, w.stock_action_at, w.end_time))
    FROM public.wms_orders w
    WHERE w.work_order_id = plan_jobs.work_order_id
       OR (w.work_order_id IS NULL AND BTRIM(COALESCE(w.order_id, '')) = BTRIM(plan_jobs.name))
  ),
  NOW()
)
WHERE is_production_voided = TRUE AND production_voided_at IS NULL;

-- Cancelled lines (including not_picked) are not sales. Keep the latest sales
-- drill-down consistent with the active-item filters used by QC and Packing.
DROP FUNCTION IF EXISTS public.rpc_product_sales_bills(UUID, DATE, DATE);
CREATE FUNCTION public.rpc_product_sales_bills(
  p_product_id UUID,
  p_from_date DATE,
  p_to_date DATE
)
RETURNS TABLE(
  order_id UUID,
  bill_no TEXT,
  work_order_name TEXT,
  entry_date DATE,
  order_status TEXT,
  total_qty NUMERIC,
  total_amount NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    o.id AS order_id,
    o.bill_no,
    o.work_order_name,
    o.entry_date,
    o.status AS order_status,
    COALESCE(SUM(oi.quantity), 0) AS total_qty,
    COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS total_amount
  FROM public.or_order_items oi
  JOIN public.or_orders o ON o.id = oi.order_id
  WHERE oi.product_id = p_product_id
    AND o.entry_date >= p_from_date
    AND o.entry_date <= p_to_date
    AND BTRIM(COALESCE(o.status, '')) IN ('จัดส่งแล้ว', 'เสร็จสิ้น')
    AND NULLIF(BTRIM(COALESCE(oi.cancellation_stock_action, '')), '') IS NULL
  GROUP BY o.id, o.bill_no, o.work_order_name, o.entry_date, o.status
  ORDER BY o.entry_date DESC, o.bill_no DESC;
$$;

REVOKE ALL ON FUNCTION public.rpc_product_sales_bills(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_product_sales_bills(UUID, DATE, DATE) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
