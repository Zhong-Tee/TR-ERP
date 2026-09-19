-- Repair Packing readiness when an order line was replaced after WMS picking.
--
-- or_order_items is referenced by wms_orders with ON DELETE SET NULL. Editing
-- an order can therefore preserve the completed WMS/stock history while its
-- source_order_item_id becomes NULL. Packing readiness previously joined only
-- by that nullable key and incorrectly displayed "ยังไม่ได้หยิบ".
--
-- Safety rules:
--   * relink only active WMS rows with a surviving source_order_id;
--   * require exactly one active order line with the same product code;
--   * never change qty, status, stock_action, or stock movements;
--   * ambiguous rows remain untouched and continue to block Packing.

BEGIN;

WITH safe_matches AS (
  SELECT
    w.id AS wms_order_id,
    (ARRAY_AGG(oi.id ORDER BY oi.id))[1] AS order_item_id
  FROM public.wms_orders w
  JOIN public.or_order_items oi
    ON oi.order_id = w.source_order_id
  JOIN public.pr_products p
    ON p.id = oi.product_id
  WHERE w.source_order_item_id IS NULL
    AND w.source_order_id IS NOT NULL
    AND w.status <> 'cancelled'
    AND NOT COALESCE(oi.is_detail_row, FALSE)
    AND NULLIF(BTRIM(COALESCE(oi.cancellation_stock_action, '')), '') IS NULL
    AND UPPER(BTRIM(COALESCE(p.product_code::TEXT, ''))) =
        UPPER(BTRIM(COALESCE(w.product_code, '')))
  GROUP BY w.id
  HAVING COUNT(*) = 1
)
UPDATE public.wms_orders w
SET source_order_item_id = matched.order_item_id
FROM safe_matches matched
WHERE w.id = matched.wms_order_id
  AND w.source_order_item_id IS NULL;

CREATE OR REPLACE FUNCTION public.fn_wms_order_ready_for_packing(p_order_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH active_items AS (
    SELECT
      oi.id AS order_item_id,
      oi.order_id,
      COALESCE(oi.quantity, 1)::NUMERIC AS expected_qty,
      UPPER(BTRIM(COALESCE(p.product_code::TEXT, ''))) AS product_code_key,
      public.fn_wms_item_fulfillment_mode(
        p.id,
        p.product_category::TEXT
      ) AS current_mode,
      COUNT(*) OVER (
        PARTITION BY oi.order_id, UPPER(BTRIM(COALESCE(p.product_code::TEXT, '')))
      ) AS same_product_line_count
    FROM public.or_order_items oi
    JOIN public.pr_products p ON p.id = oi.product_id
    WHERE oi.order_id = p_order_id
      AND NOT COALESCE(oi.is_detail_row, FALSE)
      AND NULLIF(BTRIM(COALESCE(oi.cancellation_stock_action, '')), '') IS NULL
  ), snapshots AS (
    SELECT
      item.*,
      COALESCE(snapshot.active_qty, 0)::NUMERIC AS active_qty,
      COALESCE(snapshot.correct_qty, 0)::NUMERIC AS correct_qty
    FROM active_items item
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(SUM(w.qty) FILTER (WHERE w.status <> 'cancelled'), 0)::NUMERIC AS active_qty,
        COALESCE(SUM(w.qty) FILTER (WHERE w.status = 'correct'), 0)::NUMERIC AS correct_qty
      FROM public.wms_orders w
      WHERE w.source_order_item_id = item.order_item_id
         OR (
           w.source_order_item_id IS NULL
           AND item.same_product_line_count = 1
           AND w.source_order_id = item.order_id
           AND UPPER(BTRIM(COALESCE(w.product_code, ''))) = item.product_code_key
         )
    ) snapshot ON TRUE
  )
  SELECT NOT EXISTS (
    SELECT 1
    FROM snapshots item
    WHERE (
      item.active_qty > 0
      AND item.correct_qty < item.expected_qty
    ) OR (
      item.active_qty = 0
      AND item.current_mode = 'warehouse_pick'
    )
  );
$$;

REVOKE ALL ON FUNCTION public.fn_wms_order_ready_for_packing(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_wms_order_ready_for_packing(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_wms_order_ready_for_packing(UUID) IS
  'Checks Packing readiness from completed WMS snapshots and safely resolves an orphaned WMS row by source order plus unique product code.';

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
      oi.id AS order_item_id,
      COALESCE(oi.quantity, 1)::NUMERIC AS expected_qty,
      UPPER(BTRIM(COALESCE(p.product_code::TEXT, ''))) AS product_code_key,
      public.fn_wms_item_fulfillment_mode(
        p.id,
        p.product_category::TEXT
      ) AS current_mode,
      COUNT(*) OVER (
        PARTITION BY o.id, UPPER(BTRIM(COALESCE(p.product_code::TEXT, '')))
      ) AS same_product_line_count
    FROM public.or_orders o
    JOIN public.or_order_items oi ON oi.order_id = o.id
    JOIN public.pr_products p ON p.id = oi.product_id
    WHERE o.work_order_id = p_work_order_id
      AND o.status <> 'ยกเลิก'
      AND NOT COALESCE(oi.is_detail_row, FALSE)
      AND NULLIF(BTRIM(COALESCE(oi.cancellation_stock_action, '')), '') IS NULL
  ), snapshots AS (
    SELECT
      item.*,
      COALESCE(snapshot.active_qty, 0)::NUMERIC AS active_qty,
      COALESCE(snapshot.correct_qty, 0)::NUMERIC AS correct_qty,
      COALESCE(snapshot.snapshot_picker_required, FALSE) AS snapshot_picker_required
    FROM active_items item
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(SUM(w.qty) FILTER (WHERE w.status <> 'cancelled'), 0)::NUMERIC AS active_qty,
        COALESCE(SUM(w.qty) FILTER (WHERE w.status = 'correct'), 0)::NUMERIC AS correct_qty,
        COALESCE(
          BOOL_OR(COALESCE(w.fulfillment_mode, 'warehouse_pick') = 'warehouse_pick')
            FILTER (WHERE w.status <> 'cancelled'),
          FALSE
        ) AS snapshot_picker_required
      FROM public.wms_orders w
      WHERE w.source_order_item_id = item.order_item_id
         OR (
           w.source_order_item_id IS NULL
           AND item.same_product_line_count = 1
           AND w.source_order_id = item.order_id
           AND UPPER(BTRIM(COALESCE(w.product_code, ''))) = item.product_code_key
         )
    ) snapshot ON TRUE
  ), per_item AS (
    SELECT
      item.*,
      CASE
        WHEN item.active_qty > 0 THEN item.snapshot_picker_required
        ELSE item.current_mode = 'warehouse_pick'
      END AS picker_required,
      CASE
        WHEN item.active_qty > 0 THEN item.correct_qty >= item.expected_qty
        ELSE item.current_mode <> 'warehouse_pick'
      END AS item_ready
    FROM snapshots item
  ), per_order AS (
    SELECT
      item.order_id,
      COALESCE(SUM(item.expected_qty) FILTER (WHERE item.picker_required), 0)::NUMERIC AS required_qty,
      COALESCE(SUM(LEAST(item.correct_qty, item.expected_qty)) FILTER (WHERE item.picker_required), 0)::NUMERIC AS correct_qty,
      COALESCE(SUM(GREATEST(item.expected_qty - item.correct_qty, 0)) FILTER (WHERE item.picker_required), 0)::NUMERIC AS missing_qty,
      COALESCE(BOOL_AND(item.item_ready), TRUE) AS is_ready
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
      END AS current_mode,
      COUNT(*) OVER (
        PARTITION BY o.id, UPPER(BTRIM(COALESCE(p.product_code::TEXT, '')))
      ) AS same_product_line_count
    FROM public.or_orders o
    JOIN public.or_order_items oi ON oi.order_id = o.id
    LEFT JOIN public.pr_products p ON p.id = oi.product_id
    WHERE o.work_order_id = p_work_order_id
      AND o.status <> 'ยกเลิก'
      AND NOT COALESCE(oi.is_detail_row, FALSE)
      AND NULLIF(BTRIM(COALESCE(oi.cancellation_stock_action, '')), '') IS NULL
  ), snapshots AS (
    SELECT
      item.*,
      COALESCE(snapshot.active_qty, 0)::NUMERIC AS active_qty,
      COALESCE(snapshot.correct_qty, 0)::NUMERIC AS correct_qty,
      COALESCE(snapshot.snapshot_picker_required, FALSE) AS snapshot_picker_required
    FROM active_items item
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(SUM(w.qty) FILTER (WHERE w.status <> 'cancelled'), 0)::NUMERIC AS active_qty,
        COALESCE(SUM(w.qty) FILTER (WHERE w.status = 'correct'), 0)::NUMERIC AS correct_qty,
        COALESCE(
          BOOL_OR(COALESCE(w.fulfillment_mode, 'warehouse_pick') = 'warehouse_pick')
            FILTER (WHERE w.status <> 'cancelled'),
          FALSE
        ) AS snapshot_picker_required
      FROM public.wms_orders w
      WHERE w.source_order_item_id = item.order_item_id
         OR (
           w.source_order_item_id IS NULL
           AND item.same_product_line_count = 1
           AND w.source_order_id = item.order_id
           AND UPPER(BTRIM(COALESCE(w.product_code, ''))) = item.product_code_key
         )
    ) snapshot ON TRUE
  )
  SELECT
    item.order_item_id,
    item.order_id,
    CASE
      WHEN item.active_qty > 0 THEN item.snapshot_picker_required
      ELSE item.current_mode = 'warehouse_pick'
    END,
    item.correct_qty,
    item.expected_qty,
    CASE
      WHEN item.active_qty > 0 THEN item.correct_qty >= item.expected_qty
      ELSE item.current_mode <> 'warehouse_pick'
    END
  FROM snapshots item
  ORDER BY item.order_id, item.order_item_id;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_packing_wms_item_readiness(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_packing_wms_item_readiness(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.rpc_get_packing_wms_item_readiness(UUID) IS
  'Returns Packing readiness and safely recognizes reviewed WMS rows whose order-item link was cleared by a later order edit.';

NOTIFY pgrst, 'reload schema';

COMMIT;
