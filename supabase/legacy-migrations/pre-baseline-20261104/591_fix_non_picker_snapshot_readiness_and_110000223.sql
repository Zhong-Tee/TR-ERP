-- A product can be reclassified after WMS rows were created.  Packing must not
-- keep requiring Picker review when the current product configuration says the
-- product is automatic/non-picker.  Keep the historical WMS snapshot for
-- picker-required products, but let the current non-picker setting override an
-- obsolete warehouse_pick snapshot.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_wms_order_ready_for_packing(p_order_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH target_order AS (
    SELECT o.id, o.work_order_id
    FROM public.or_orders o
    WHERE o.id = p_order_id
  ), active_items AS (
    SELECT
      o.id AS order_id,
      o.work_order_id,
      COALESCE(oi.quantity, 1)::NUMERIC AS expected_qty,
      UPPER(BTRIM(COALESCE(p.product_code::TEXT, ''))) AS product_code_key,
      public.fn_wms_item_fulfillment_mode(p.id, p.product_category::TEXT) AS current_mode
    FROM target_order target
    JOIN public.or_orders o
      ON (target.work_order_id IS NOT NULL AND o.work_order_id = target.work_order_id)
      OR (target.work_order_id IS NULL AND o.id = target.id)
    JOIN public.or_order_items oi ON oi.order_id = o.id
    JOIN public.pr_products p ON p.id = oi.product_id
    WHERE o.status <> 'ยกเลิก'
      AND NOT COALESCE(oi.is_detail_row, FALSE)
      AND NULLIF(BTRIM(COALESCE(oi.cancellation_stock_action, '')), '') IS NULL
  ), item_groups AS (
    SELECT
      item.work_order_id,
      item.product_code_key,
      SUM(item.expected_qty)::NUMERIC AS expected_qty,
      BOOL_OR(item.current_mode = 'warehouse_pick') AS current_picker_required
    FROM active_items item
    GROUP BY item.work_order_id, item.product_code_key
  ), wms_groups AS (
    SELECT
      w.work_order_id,
      UPPER(BTRIM(COALESCE(w.product_code, ''))) AS product_code_key,
      COALESCE(SUM(w.qty) FILTER (WHERE w.status <> 'cancelled'), 0)::NUMERIC AS active_qty,
      COALESCE(SUM(w.qty) FILTER (WHERE w.status = 'correct'), 0)::NUMERIC AS correct_qty
    FROM target_order target
    JOIN public.wms_orders w
      ON (target.work_order_id IS NOT NULL AND w.work_order_id = target.work_order_id)
      OR (target.work_order_id IS NULL AND w.source_order_id = target.id)
    GROUP BY w.work_order_id, UPPER(BTRIM(COALESCE(w.product_code, '')))
  ), group_readiness AS (
    SELECT
      item.work_order_id,
      item.product_code_key,
      CASE
        WHEN NOT item.current_picker_required THEN TRUE
        WHEN COALESCE(wms.active_qty, 0) > 0
          THEN COALESCE(wms.correct_qty, 0) >= item.expected_qty
        ELSE FALSE
      END AS ready
    FROM item_groups item
    LEFT JOIN wms_groups wms
      ON wms.work_order_id IS NOT DISTINCT FROM item.work_order_id
     AND wms.product_code_key = item.product_code_key
  )
  SELECT COALESCE(BOOL_AND(readiness.ready), TRUE)
  FROM active_items item
  JOIN group_readiness readiness
    ON readiness.work_order_id IS NOT DISTINCT FROM item.work_order_id
   AND readiness.product_code_key = item.product_code_key
  WHERE item.order_id = p_order_id;
$$;

REVOKE ALL ON FUNCTION public.fn_wms_order_ready_for_packing(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_wms_order_ready_for_packing(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rpc_get_packing_wms_readiness(p_work_order_id UUID)
RETURNS TABLE(
  order_id UUID,
  picker_required_qty NUMERIC,
  picker_correct_qty NUMERIC,
  picker_missing_qty NUMERIC,
  ready BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH active_items AS (
    SELECT
      o.id AS order_id,
      COALESCE(oi.quantity, 1)::NUMERIC AS expected_qty,
      UPPER(BTRIM(COALESCE(p.product_code::TEXT, ''))) AS product_code_key,
      public.fn_wms_item_fulfillment_mode(p.id, p.product_category::TEXT) AS current_mode
    FROM public.or_orders o
    JOIN public.or_order_items oi ON oi.order_id = o.id
    JOIN public.pr_products p ON p.id = oi.product_id
    WHERE o.work_order_id = p_work_order_id
      AND o.status <> 'ยกเลิก'
      AND NOT COALESCE(oi.is_detail_row, FALSE)
      AND NULLIF(BTRIM(COALESCE(oi.cancellation_stock_action, '')), '') IS NULL
  ), item_groups AS (
    SELECT
      item.product_code_key,
      SUM(item.expected_qty)::NUMERIC AS expected_qty,
      BOOL_OR(item.current_mode = 'warehouse_pick') AS current_picker_required
    FROM active_items item
    GROUP BY item.product_code_key
  ), wms_groups AS (
    SELECT
      UPPER(BTRIM(COALESCE(w.product_code, ''))) AS product_code_key,
      COALESCE(SUM(w.qty) FILTER (WHERE w.status <> 'cancelled'), 0)::NUMERIC AS active_qty,
      COALESCE(SUM(w.qty) FILTER (WHERE w.status = 'correct'), 0)::NUMERIC AS correct_qty
    FROM public.wms_orders w
    WHERE w.work_order_id = p_work_order_id
    GROUP BY UPPER(BTRIM(COALESCE(w.product_code, '')))
  ), group_readiness AS (
    SELECT
      item.product_code_key,
      item.expected_qty,
      COALESCE(wms.correct_qty, 0)::NUMERIC AS correct_qty,
      item.current_picker_required AS picker_required,
      CASE
        WHEN NOT item.current_picker_required THEN TRUE
        WHEN COALESCE(wms.active_qty, 0) > 0
          THEN COALESCE(wms.correct_qty, 0) >= item.expected_qty
        ELSE FALSE
      END AS ready
    FROM item_groups item
    LEFT JOIN wms_groups wms ON wms.product_code_key = item.product_code_key
  ), per_item AS (
    SELECT item.*, readiness.picker_required, readiness.ready
    FROM active_items item
    JOIN group_readiness readiness ON readiness.product_code_key = item.product_code_key
  ), per_order AS (
    SELECT
      item.order_id,
      COALESCE(SUM(item.expected_qty) FILTER (WHERE item.picker_required), 0)::NUMERIC AS required_qty,
      COALESCE(SUM(
        CASE WHEN item.picker_required AND item.ready THEN item.expected_qty ELSE 0 END
      ), 0)::NUMERIC AS correct_qty,
      COALESCE(SUM(
        CASE WHEN item.picker_required AND NOT item.ready THEN item.expected_qty ELSE 0 END
      ), 0)::NUMERIC AS missing_qty,
      COALESCE(BOOL_AND(item.ready), TRUE) AS is_ready
    FROM per_item item
    GROUP BY item.order_id
  )
  SELECT
    o.id,
    COALESCE(summary.required_qty, 0),
    COALESCE(summary.correct_qty, 0),
    COALESCE(summary.missing_qty, 0),
    COALESCE(summary.is_ready, TRUE)
  FROM public.or_orders o
  LEFT JOIN per_order summary ON summary.order_id = o.id
  WHERE o.work_order_id = p_work_order_id
    AND o.status <> 'ยกเลิก'
  ORDER BY o.bill_no, o.id;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_packing_wms_readiness(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_packing_wms_readiness(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rpc_get_packing_wms_item_readiness(p_work_order_id UUID)
RETURNS TABLE(
  order_item_id UUID,
  order_id UUID,
  picker_required BOOLEAN,
  picker_correct_qty NUMERIC,
  expected_qty NUMERIC,
  ready BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH active_items AS (
    SELECT
      oi.id AS order_item_id,
      o.id AS order_id,
      COALESCE(oi.quantity, 1)::NUMERIC AS expected_qty,
      UPPER(BTRIM(COALESCE(p.product_code::TEXT, ''))) AS product_code_key,
      CASE
        WHEN p.id IS NULL THEN 'system_complete'
        ELSE public.fn_wms_item_fulfillment_mode(p.id, p.product_category::TEXT)
      END AS current_mode
    FROM public.or_orders o
    JOIN public.or_order_items oi ON oi.order_id = o.id
    LEFT JOIN public.pr_products p ON p.id = oi.product_id
    WHERE o.work_order_id = p_work_order_id
      AND o.status <> 'ยกเลิก'
      AND NOT COALESCE(oi.is_detail_row, FALSE)
      AND NULLIF(BTRIM(COALESCE(oi.cancellation_stock_action, '')), '') IS NULL
  ), item_groups AS (
    SELECT
      item.product_code_key,
      SUM(item.expected_qty)::NUMERIC AS expected_qty,
      BOOL_OR(item.current_mode = 'warehouse_pick') AS current_picker_required
    FROM active_items item
    GROUP BY item.product_code_key
  ), wms_groups AS (
    SELECT
      UPPER(BTRIM(COALESCE(w.product_code, ''))) AS product_code_key,
      COALESCE(SUM(w.qty) FILTER (WHERE w.status <> 'cancelled'), 0)::NUMERIC AS active_qty,
      COALESCE(SUM(w.qty) FILTER (WHERE w.status = 'correct'), 0)::NUMERIC AS correct_qty
    FROM public.wms_orders w
    WHERE w.work_order_id = p_work_order_id
    GROUP BY UPPER(BTRIM(COALESCE(w.product_code, '')))
  ), group_readiness AS (
    SELECT
      item.product_code_key,
      COALESCE(wms.correct_qty, 0)::NUMERIC AS correct_qty,
      item.current_picker_required AS picker_required,
      CASE
        WHEN NOT item.current_picker_required THEN TRUE
        WHEN COALESCE(wms.active_qty, 0) > 0
          THEN COALESCE(wms.correct_qty, 0) >= item.expected_qty
        ELSE FALSE
      END AS ready
    FROM item_groups item
    LEFT JOIN wms_groups wms ON wms.product_code_key = item.product_code_key
  )
  SELECT
    item.order_item_id,
    item.order_id,
    readiness.picker_required,
    CASE
      WHEN readiness.ready THEN item.expected_qty
      ELSE LEAST(readiness.correct_qty, item.expected_qty)
    END,
    item.expected_qty,
    readiness.ready
  FROM active_items item
  JOIN group_readiness readiness ON readiness.product_code_key = item.product_code_key
  ORDER BY item.order_id, item.order_item_id;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_packing_wms_item_readiness(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_packing_wms_item_readiness(UUID) TO authenticated, service_role;

-- Ensure STK remains an authoritative non-picker category.
INSERT INTO public.wms_non_picker_categories (category_name)
VALUES ('STK')
ON CONFLICT DO NOTHING;

-- Repair only unshipped, non-cancelled work orders which currently contain
-- product 110000223.  Moving pending rows to correct invokes the existing WMS
-- stock trigger, which is idempotent per wms_orders row and aborts safely if
-- there is not enough stock.
DO $$
DECLARE
  v_product_id UUID;
  v_mode TEXT;
  v_repaired INTEGER := 0;
BEGIN
  SELECT p.id
  INTO v_product_id
  FROM public.pr_products p
  WHERE BTRIM(p.product_code::TEXT) = '110000223'
  ORDER BY p.id
  LIMIT 1;

  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'ไม่พบสินค้า 110000223 จึงยกเลิกการซ่อม';
  END IF;

  SELECT public.fn_wms_item_fulfillment_mode(p.id, p.product_category::TEXT)
  INTO v_mode
  FROM public.pr_products p
  WHERE p.id = v_product_id;

  IF v_mode = 'warehouse_pick' THEN
    RAISE EXCEPTION 'สินค้า 110000223 ยังถูกตั้งค่าเป็นต้องหยิบ จึงยกเลิกการซ่อม';
  END IF;

  UPDATE public.wms_orders w
  SET fulfillment_mode = v_mode,
      assigned_to = NULL,
      status = 'correct',
      end_time = COALESCE(w.end_time, NOW())
  WHERE UPPER(BTRIM(COALESCE(w.product_code, ''))) = '110000223'
    AND w.status = 'pending'
    AND EXISTS (
      SELECT 1
      FROM public.or_orders o
      JOIN public.or_order_items oi ON oi.order_id = o.id
      WHERE o.work_order_id = w.work_order_id
        AND oi.product_id = v_product_id
        AND o.status NOT IN ('ยกเลิก', 'จัดส่งแล้ว')
        AND NOT COALESCE(oi.is_detail_row, FALSE)
        AND NULLIF(BTRIM(COALESCE(oi.cancellation_stock_action, '')), '') IS NULL
    );

  GET DIAGNOSTICS v_repaired = ROW_COUNT;
  RAISE NOTICE 'ซ่อม WMS สินค้า 110000223 จำนวน % แถว', v_repaired;
END;
$$;

COMMENT ON FUNCTION public.fn_wms_order_ready_for_packing(UUID) IS
  'Packing readiness uses current non-picker configuration as an override, while retaining WMS quantity checks for products that currently require Picker.';

COMMENT ON FUNCTION public.rpc_get_packing_wms_item_readiness(UUID) IS
  'Returns per-item readiness; current automatic/non-picker products are ready even when an obsolete warehouse_pick snapshot exists.';

NOTIFY pgrst, 'reload schema';

COMMIT;
