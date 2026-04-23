-- ============================================
-- Sub Warehouse: allow history search by product name/code
-- - Extends rpc_get_sub_warehouse_moves filter to support:
--   product_code ILIKE %term% OR product_name ILIKE %term%
-- ============================================

DROP FUNCTION IF EXISTS rpc_get_sub_warehouse_moves(UUID, DATE, DATE, TEXT);
CREATE FUNCTION rpc_get_sub_warehouse_moves(
  p_sub_warehouse_id UUID,
  p_date_from DATE,
  p_date_to DATE,
  p_product_code TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  created_at TIMESTAMPTZ,
  created_by UUID,
  product_id UUID,
  product_code TEXT,
  product_name TEXT,
  unit_name TEXT,
  qty_delta NUMERIC,
  reason TEXT,
  note TEXT,
  balance_after NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  WITH filtered AS (
    SELECT
      m.*,
      p.product_code,
      p.product_name,
      p.unit_name
    FROM wh_sub_warehouse_stock_moves m
    JOIN pr_products p ON p.id = m.product_id
    WHERE m.sub_warehouse_id = p_sub_warehouse_id
      AND m.created_at >= (p_date_from::timestamptz)
      AND m.created_at < ((p_date_to + 1)::timestamptz)
      AND (
        p_product_code IS NULL OR btrim(p_product_code) = ''
        OR p.product_code ILIKE ('%' || btrim(p_product_code) || '%')
        OR p.product_name ILIKE ('%' || btrim(p_product_code) || '%')
      )
  )
  SELECT
    f.id,
    f.created_at,
    f.created_by,
    f.product_id,
    f.product_code,
    f.product_name,
    f.unit_name,
    f.qty_delta,
    f.reason,
    f.note,
    SUM(f.qty_delta) OVER (
      PARTITION BY f.product_id
      ORDER BY f.created_at, f.id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS balance_after
  FROM filtered f
  ORDER BY f.created_at DESC, f.id DESC;
$$;

GRANT EXECUTE ON FUNCTION rpc_get_sub_warehouse_moves(UUID, DATE, DATE, TEXT) TO authenticated;

