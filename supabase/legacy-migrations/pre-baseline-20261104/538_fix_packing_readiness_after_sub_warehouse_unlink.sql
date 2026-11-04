-- Keep Packing readiness tied to the WMS fulfillment snapshot that was created
-- with the work order.  Changing a product's sub-warehouse assignment later
-- must not retroactively turn an already completed sub_warehouse_skip row into
-- an unpicked warehouse_pick requirement.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_wms_order_ready_for_packing(p_order_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.or_order_items oi
    JOIN public.pr_products p ON p.id=oi.product_id
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(SUM(w.qty) FILTER (WHERE w.status<>'cancelled'),0)::NUMERIC AS active_qty,
        COALESCE(SUM(w.qty) FILTER (WHERE w.status='correct'),0)::NUMERIC AS correct_qty
      FROM public.wms_orders w
      WHERE w.source_order_item_id=oi.id
    ) snapshot ON TRUE
    WHERE oi.order_id=p_order_id
      AND NOT COALESCE(oi.is_detail_row,false)
      AND NULLIF(BTRIM(COALESCE(oi.cancellation_stock_action,'')),'') IS NULL
      AND (
        -- Existing WMS rows are the immutable fulfillment decision for this
        -- work order, regardless of later product configuration changes.
        (snapshot.active_qty>0
          AND snapshot.correct_qty<COALESCE(oi.quantity,1)::NUMERIC)
        OR
        -- Use current configuration only to detect a genuinely missing WMS
        -- row that should have gone through the main Picker.
        (snapshot.active_qty=0
          AND public.fn_wms_item_fulfillment_mode(p.id,p.product_category::TEXT)='warehouse_pick')
      )
  );
$$;

REVOKE ALL ON FUNCTION public.fn_wms_order_ready_for_packing(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wms_order_ready_for_packing(UUID) TO authenticated,service_role;

COMMENT ON FUNCTION public.fn_wms_order_ready_for_packing(UUID) IS
  'True when existing WMS fulfillment snapshots are complete; current product configuration is consulted only when a line has no active WMS row.';

CREATE OR REPLACE FUNCTION public.rpc_get_packing_wms_readiness(p_work_order_id UUID)
RETURNS TABLE(
  order_id UUID,
  picker_required_qty NUMERIC,
  picker_correct_qty NUMERIC,
  picker_missing_qty NUMERIC,
  ready BOOLEAN
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH active_items AS (
    SELECT
      o.id AS order_id,
      oi.id AS order_item_id,
      COALESCE(oi.quantity,1)::NUMERIC AS expected_qty,
      public.fn_wms_item_fulfillment_mode(p.id,p.product_category::TEXT) AS current_mode
    FROM public.or_orders o
    JOIN public.or_order_items oi ON oi.order_id=o.id
    JOIN public.pr_products p ON p.id=oi.product_id
    WHERE o.work_order_id=p_work_order_id
      AND o.status<>'ยกเลิก'
      AND NOT COALESCE(oi.is_detail_row,false)
      AND NULLIF(BTRIM(COALESCE(oi.cancellation_stock_action,'')),'') IS NULL
  ), snapshot AS (
    SELECT
      ai.order_id,
      ai.order_item_id,
      ai.expected_qty,
      ai.current_mode,
      COALESCE(SUM(w.qty) FILTER (WHERE w.status<>'cancelled'),0)::NUMERIC AS active_qty,
      COALESCE(SUM(w.qty) FILTER (WHERE w.status='correct'),0)::NUMERIC AS correct_qty,
      COALESCE(BOOL_OR(
        COALESCE(w.fulfillment_mode,'warehouse_pick')='warehouse_pick'
      ) FILTER (WHERE w.status<>'cancelled'),FALSE) AS snapshot_picker_required
    FROM active_items ai
    LEFT JOIN public.wms_orders w ON w.source_order_item_id=ai.order_item_id
    GROUP BY ai.order_id,ai.order_item_id,ai.expected_qty,ai.current_mode
  ), per_item AS (
    SELECT
      s.*,
      CASE
        WHEN s.active_qty>0 THEN s.snapshot_picker_required
        ELSE s.current_mode='warehouse_pick'
      END AS picker_required,
      CASE
        WHEN s.active_qty>0 THEN s.correct_qty>=s.expected_qty
        ELSE s.current_mode<>'warehouse_pick'
      END AS item_ready
    FROM snapshot s
  ), per_order AS (
    SELECT
      pi.order_id,
      COALESCE(SUM(pi.expected_qty) FILTER (WHERE pi.picker_required),0)::NUMERIC AS required_qty,
      COALESCE(SUM(LEAST(pi.correct_qty,pi.expected_qty)) FILTER (WHERE pi.picker_required),0)::NUMERIC AS correct_qty,
      COALESCE(SUM(GREATEST(pi.expected_qty-pi.correct_qty,0)) FILTER (WHERE pi.picker_required),0)::NUMERIC AS missing_qty,
      COALESCE(BOOL_AND(pi.item_ready),TRUE) AS ready
    FROM per_item pi
    GROUP BY pi.order_id
  )
  SELECT
    o.id,
    COALESCE(po.required_qty,0),
    COALESCE(po.correct_qty,0),
    COALESCE(po.missing_qty,0),
    COALESCE(po.ready,TRUE)
  FROM public.or_orders o
  LEFT JOIN per_order po ON po.order_id=o.id
  WHERE o.work_order_id=p_work_order_id AND o.status<>'ยกเลิก'
  ORDER BY o.bill_no,o.id;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_packing_wms_readiness(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_packing_wms_readiness(UUID) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.rpc_get_packing_wms_item_readiness(p_work_order_id UUID)
RETURNS TABLE(
  order_item_id UUID,
  order_id UUID,
  picker_required BOOLEAN,
  picker_correct_qty NUMERIC,
  expected_qty NUMERIC,
  ready BOOLEAN
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH active_items AS (
    SELECT
      oi.id AS order_item_id,
      o.id AS order_id,
      COALESCE(oi.quantity,1)::NUMERIC AS expected_qty,
      CASE
        WHEN p.id IS NULL THEN 'system_complete'
        ELSE public.fn_wms_item_fulfillment_mode(p.id,p.product_category::TEXT)
      END AS current_mode
    FROM public.or_orders o
    JOIN public.or_order_items oi ON oi.order_id=o.id
    LEFT JOIN public.pr_products p ON p.id=oi.product_id
    WHERE o.work_order_id=p_work_order_id
      AND o.status<>'ยกเลิก'
      AND NOT COALESCE(oi.is_detail_row,false)
      AND NULLIF(BTRIM(COALESCE(oi.cancellation_stock_action,'')),'') IS NULL
  ), snapshot AS (
    SELECT
      ai.order_item_id,
      ai.order_id,
      ai.expected_qty,
      ai.current_mode,
      COALESCE(SUM(w.qty) FILTER (WHERE w.status<>'cancelled'),0)::NUMERIC AS active_qty,
      COALESCE(SUM(w.qty) FILTER (WHERE w.status='correct'),0)::NUMERIC AS correct_qty,
      COALESCE(BOOL_OR(
        COALESCE(w.fulfillment_mode,'warehouse_pick')='warehouse_pick'
      ) FILTER (WHERE w.status<>'cancelled'),FALSE) AS snapshot_picker_required
    FROM active_items ai
    LEFT JOIN public.wms_orders w ON w.source_order_item_id=ai.order_item_id
    GROUP BY ai.order_item_id,ai.order_id,ai.expected_qty,ai.current_mode
  )
  SELECT
    s.order_item_id,
    s.order_id,
    CASE
      WHEN s.active_qty>0 THEN s.snapshot_picker_required
      ELSE s.current_mode='warehouse_pick'
    END,
    s.correct_qty,
    s.expected_qty,
    CASE
      WHEN s.active_qty>0 THEN s.correct_qty>=s.expected_qty
      ELSE s.current_mode<>'warehouse_pick'
    END
  FROM snapshot s
  ORDER BY s.order_id,s.order_item_id;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_packing_wms_item_readiness(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_packing_wms_item_readiness(UUID) TO authenticated,service_role;

COMMENT ON FUNCTION public.rpc_get_packing_wms_item_readiness(UUID) IS
  'Returns Packing readiness from the WMS snapshot saved with the work order, so later product configuration changes do not alter historical fulfillment.';

COMMIT;
