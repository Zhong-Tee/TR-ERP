BEGIN;

CREATE OR REPLACE FUNCTION rpc_get_pending_po_by_product()
RETURNS TABLE (
  product_id UUID,
  pending_qty NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    poi.product_id,
    SUM(
      GREATEST(
        COALESCE(poi.qty, 0)
        - COALESCE(poi.qty_received_total, 0)
        - COALESCE(poi.resolution_qty, 0),
        0
      )
    ) AS pending_qty
  FROM inv_po_items poi
  JOIN inv_po po ON po.id = poi.po_id
  WHERE po.status IN ('ordered', 'partial')
  GROUP BY poi.product_id
  HAVING SUM(
    GREATEST(
      COALESCE(poi.qty, 0)
      - COALESCE(poi.qty_received_total, 0)
      - COALESCE(poi.resolution_qty, 0),
      0
    )
  ) > 0;
$$;

COMMIT;
