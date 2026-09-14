-- Read-only verification for the SPTR-140969-R3 incident.
-- Run this after migration 538 in the Supabase SQL Editor.
-- Expected for the three affected product lines:
--   active_wms_qty = correct_wms_qty = order_qty
--   saved_fulfillment_modes contains sub_warehouse_skip
--   ready_after_fix = true

WITH target_orders AS (
  SELECT o.*
  FROM public.or_orders o
  WHERE BTRIM(COALESCE(o.work_order_name,''))='SPTR-140969-R3'
    AND BTRIM(COALESCE(o.tracking_number,'')) IN (
      'TH269629483940J',
      'TH2605826726280'
    )
)
SELECT
  o.work_order_name,
  o.bill_no,
  o.tracking_number,
  oi.id AS order_item_id,
  p.product_code,
  oi.product_name,
  COALESCE(oi.quantity,1)::NUMERIC AS order_qty,
  public.fn_wms_item_fulfillment_mode(
    p.id,
    p.product_category::TEXT
  ) AS current_config_mode,
  snapshot.saved_fulfillment_modes,
  snapshot.active_wms_qty,
  snapshot.correct_wms_qty,
  snapshot.deducted_stock_qty,
  public.fn_wms_order_ready_for_packing(o.id) AS ready_after_fix
FROM target_orders o
JOIN public.or_order_items oi ON oi.order_id=o.id
JOIN public.pr_products p ON p.id=oi.product_id
LEFT JOIN LATERAL (
  SELECT
    STRING_AGG(DISTINCT COALESCE(w.fulfillment_mode,'warehouse_pick'),', ')
      FILTER (WHERE w.status<>'cancelled') AS saved_fulfillment_modes,
    COALESCE(SUM(w.qty) FILTER (WHERE w.status<>'cancelled'),0)::NUMERIC AS active_wms_qty,
    COALESCE(SUM(w.qty) FILTER (WHERE w.status='correct'),0)::NUMERIC AS correct_wms_qty,
    COALESCE((
      SELECT SUM(-movement.qty)
      FROM public.wms_orders movement_wms
      JOIN public.inv_stock_movements movement
        ON movement.ref_type='wms_orders'
       AND movement.ref_id=movement_wms.id
       AND movement.movement_type IN ('pick','pick_reversal')
      WHERE movement_wms.source_order_item_id=oi.id
    ),0)::NUMERIC AS deducted_stock_qty
  FROM public.wms_orders w
  WHERE w.source_order_item_id=oi.id
) snapshot ON TRUE
WHERE NOT COALESCE(oi.is_detail_row,false)
  AND NULLIF(BTRIM(COALESCE(oi.cancellation_stock_action,'')),'') IS NULL
ORDER BY o.tracking_number,oi.id;

-- Every row returned here should have ready=true.  A false row with an
-- incomplete/absent WMS snapshot is a real Picker issue and is intentionally
-- not bypassed by migration 538.
SELECT
  wo.work_order_name,
  readiness.*
FROM public.or_work_orders wo
CROSS JOIN LATERAL public.rpc_get_packing_wms_item_readiness(wo.id) readiness
WHERE BTRIM(COALESCE(wo.work_order_name,''))='SPTR-140969-R3'
ORDER BY readiness.order_id,readiness.order_item_id;
