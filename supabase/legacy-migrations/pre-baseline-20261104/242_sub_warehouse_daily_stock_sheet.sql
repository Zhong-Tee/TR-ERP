-- ============================================
-- Sub warehouse: daily stock sheet (Thailand calendar day)
-- For each assigned product: opening received, day replenish/reduce,
-- WMS opening/day, expected balance opening / EOD.
-- ============================================

DROP FUNCTION IF EXISTS rpc_get_sub_warehouse_daily_stock_sheet(UUID, DATE);

CREATE FUNCTION rpc_get_sub_warehouse_daily_stock_sheet(
  p_sub_warehouse_id UUID,
  p_date DATE
)
RETURNS TABLE (
  product_id UUID,
  product_code TEXT,
  product_name TEXT,
  unit_name TEXT,
  received_opening NUMERIC,
  replenish_day NUMERIC,
  reduce_day NUMERIC,
  wms_opening NUMERIC,
  wms_day NUMERIC,
  balance_opening NUMERIC,
  balance_eod NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  WITH bounds AS (
    SELECT
      make_timestamptz(
        EXTRACT(YEAR FROM p_date)::int,
        EXTRACT(MONTH FROM p_date)::int,
        EXTRACT(DAY FROM p_date)::int,
        0, 0, 0,
        'Asia/Bangkok'
      ) AS day_start,
      make_timestamptz(
        EXTRACT(YEAR FROM p_date)::int,
        EXTRACT(MONTH FROM p_date)::int,
        EXTRACT(DAY FROM p_date)::int,
        0, 0, 0,
        'Asia/Bangkok'
      ) + interval '1 day' AS day_end_excl
  ),
  products AS (
    SELECT
      sp.product_id,
      p.product_code,
      p.product_name,
      p.unit_name
    FROM wh_sub_warehouse_products sp
    JOIN pr_products p ON p.id = sp.product_id
    WHERE sp.sub_warehouse_id = p_sub_warehouse_id
  ),
  recv_open AS (
    SELECT
      m.product_id,
      COALESCE(SUM(m.qty_delta), 0)::numeric AS qty
    FROM wh_sub_warehouse_stock_moves m
    CROSS JOIN bounds b
    WHERE m.sub_warehouse_id = p_sub_warehouse_id
      AND m.created_at < b.day_start
    GROUP BY m.product_id
  ),
  recv_day AS (
    SELECT
      m.product_id,
      COALESCE(SUM(CASE WHEN m.qty_delta > 0 THEN m.qty_delta ELSE 0 END), 0)::numeric AS replenish,
      COALESCE(SUM(CASE WHEN m.qty_delta < 0 THEN m.qty_delta ELSE 0 END), 0)::numeric AS reduce_sum
    FROM wh_sub_warehouse_stock_moves m
    CROSS JOIN bounds b
    WHERE m.sub_warehouse_id = p_sub_warehouse_id
      AND m.created_at >= b.day_start
      AND m.created_at < b.day_end_excl
    GROUP BY m.product_id
  ),
  wms_open AS (
    SELECT
      o.product_code::text AS product_code,
      COALESCE(SUM(o.qty), 0)::numeric AS qty
    FROM wms_orders o
    JOIN wms_order_summaries s ON s.order_id = o.order_id
    CROSS JOIN bounds b
    WHERE o.status = 'correct'
      AND s.checked_at < b.day_start
    GROUP BY o.product_code
  ),
  wms_day_tbl AS (
    SELECT
      o.product_code::text AS product_code,
      COALESCE(SUM(o.qty), 0)::numeric AS qty
    FROM wms_orders o
    JOIN wms_order_summaries s ON s.order_id = o.order_id
    CROSS JOIN bounds b
    WHERE o.status = 'correct'
      AND s.checked_at >= b.day_start
      AND s.checked_at < b.day_end_excl
    GROUP BY o.product_code
  )
  SELECT
    pr.product_id,
    pr.product_code,
    pr.product_name,
    pr.unit_name,
    COALESCE(ro.qty, 0)::numeric AS received_opening,
    COALESCE(rd.replenish, 0)::numeric AS replenish_day,
    COALESCE(rd.reduce_sum, 0)::numeric AS reduce_day,
    COALESCE(wo.qty, 0)::numeric AS wms_opening,
    COALESCE(wd.qty, 0)::numeric AS wms_day,
    (COALESCE(ro.qty, 0) - COALESCE(wo.qty, 0))::numeric AS balance_opening,
    (
      (COALESCE(ro.qty, 0) + COALESCE(rd.replenish, 0) + COALESCE(rd.reduce_sum, 0))
      - (COALESCE(wo.qty, 0) + COALESCE(wd.qty, 0))
    )::numeric AS balance_eod
  FROM products pr
  LEFT JOIN recv_open ro ON ro.product_id = pr.product_id
  LEFT JOIN recv_day rd ON rd.product_id = pr.product_id
  LEFT JOIN wms_open wo ON wo.product_code = pr.product_code
  LEFT JOIN wms_day_tbl wd ON wd.product_code = pr.product_code
  ORDER BY pr.product_code ASC;
$$;

GRANT EXECUTE ON FUNCTION rpc_get_sub_warehouse_daily_stock_sheet(UUID, DATE) TO authenticated;
