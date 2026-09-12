-- Correct ST snapshots in audits that are still active. Historical completed
-- and closed audits remain immutable. ST represents the aggregate Warehouse
-- total of linked production SKUs and does not own FIFO stock of its own.
BEGIN;

WITH st_totals AS (
  SELECT
    spare.product_id AS spare_product_id,
    COALESCE(SUM(COALESCE(balance.on_hand, 0) + COALESCE(balance.safety_stock, 0)), 0) AS system_qty
  FROM public.wh_sub_wms_map_spares AS spare
  LEFT JOIN public.wh_sub_wms_map_sources AS source
    ON source.group_id = spare.group_id
  LEFT JOIN public.inv_stock_balances AS balance
    ON balance.product_id = source.product_id
  GROUP BY spare.product_id
), updated_items AS (
  UPDATE public.inv_audit_items AS item
  SET
    system_qty = totals.system_qty,
    system_safety_stock = NULL,
    counted_safety_stock = NULL,
    safety_stock_match = NULL,
    variance = CASE
      WHEN item.is_counted THEN COALESCE(item.counted_qty, 0) - totals.system_qty
      ELSE 0
    END
  FROM st_totals AS totals, public.inv_audits AS audit
  WHERE item.product_id = totals.spare_product_id
    AND audit.id = item.audit_id
    AND audit.status IN ('draft', 'in_progress', 'review')
  RETURNING item.audit_id
), affected_audits AS (
  SELECT DISTINCT audit_id FROM updated_items
), audit_stats AS (
  SELECT
    item.audit_id,
    COUNT(*) FILTER (WHERE item.is_counted) AS counted_items,
    COALESCE(SUM(ABS(COALESCE(item.variance, 0))) FILTER (WHERE item.is_counted), 0) AS total_variance,
    COUNT(*) FILTER (WHERE item.is_counted AND COALESCE(item.variance, 0) = 0) AS matched_items
  FROM public.inv_audit_items AS item
  JOIN affected_audits AS affected ON affected.audit_id = item.audit_id
  GROUP BY item.audit_id
)
UPDATE public.inv_audits AS audit
SET
  total_items = stats.counted_items,
  total_variance = stats.total_variance,
  accuracy_percent = CASE
    WHEN stats.counted_items > 0
      THEN ROUND((stats.matched_items::NUMERIC / stats.counted_items::NUMERIC) * 100, 2)
    ELSE 0
  END
FROM audit_stats AS stats
WHERE audit.id = stats.audit_id;

COMMIT;
