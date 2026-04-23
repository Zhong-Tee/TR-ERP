-- ============================================
-- Sub Warehouse RPCs / Views
-- - Balance per product
-- - Moves history with running balance
-- - WMS correct qty (production qty) per product_code
-- ============================================

-- 1) Simple balance view
CREATE OR REPLACE VIEW wh_sub_warehouse_balances AS
SELECT
  m.sub_warehouse_id,
  m.product_id,
  COALESCE(SUM(m.qty_delta), 0) AS qty_on_hand
FROM wh_sub_warehouse_stock_moves m
GROUP BY m.sub_warehouse_id, m.product_id;

-- 2) RPC: balances for a sub warehouse (includes product fields)
DROP FUNCTION IF EXISTS rpc_get_sub_warehouse_balances(UUID);
CREATE FUNCTION rpc_get_sub_warehouse_balances(p_sub_warehouse_id UUID)
RETURNS TABLE (
  product_id UUID,
  product_code TEXT,
  product_name TEXT,
  unit_name TEXT,
  qty_on_hand NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    p.id AS product_id,
    p.product_code,
    p.product_name,
    p.unit_name,
    COALESCE(b.qty_on_hand, 0) AS qty_on_hand
  FROM wh_sub_warehouse_products sp
  JOIN pr_products p ON p.id = sp.product_id
  LEFT JOIN wh_sub_warehouse_balances b
    ON b.sub_warehouse_id = sp.sub_warehouse_id
   AND b.product_id = sp.product_id
  WHERE sp.sub_warehouse_id = p_sub_warehouse_id
  ORDER BY p.product_code ASC;
$$;

GRANT EXECUTE ON FUNCTION rpc_get_sub_warehouse_balances(UUID) TO authenticated;

-- 3) RPC: moves history with running balance (by product_code filter optional)
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
        p_product_code IS NULL OR p_product_code = '' OR p.product_code = p_product_code
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

-- 4) RPC: WMS correct qty grouped by product_code (by checked_at window)
-- Uses wms_order_summaries.checked_at as the "ตรวจเสร็จ" timestamp, consistent with ReviewSection.saveFirstCheckSummary
DROP FUNCTION IF EXISTS rpc_get_wms_correct_qty_by_product(TIMESTAMPTZ, TIMESTAMPTZ);
CREATE FUNCTION rpc_get_wms_correct_qty_by_product(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS TABLE (
  product_code TEXT,
  correct_qty NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    o.product_code,
    COALESCE(SUM(o.qty), 0) AS correct_qty
  FROM wms_orders o
  JOIN wms_order_summaries s ON s.order_id = o.order_id
  WHERE s.checked_at >= p_from
    AND s.checked_at <= p_to
    AND o.status = 'correct'
  GROUP BY o.product_code
  ORDER BY o.product_code ASC;
$$;

GRANT EXECUTE ON FUNCTION rpc_get_wms_correct_qty_by_product(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

