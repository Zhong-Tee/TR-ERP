-- 215: exclude cancelled orders from product sales summary
ALTER TABLE public.or_order_items
  ADD COLUMN IF NOT EXISTS cancellation_stock_action TEXT;

CREATE OR REPLACE FUNCTION rpc_product_sales_summary(
  p_from_date DATE,
  p_to_date DATE
)
RETURNS TABLE(
  product_id UUID,
  product_code TEXT,
  product_name TEXT,
  product_type TEXT,
  total_qty NUMERIC,
  total_amount NUMERIC,
  order_count BIGINT
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT
    p.id            AS product_id,
    p.product_code,
    p.product_name,
    p.product_type,
    COALESCE(SUM(oi.quantity), 0)                  AS total_qty,
    COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS total_amount,
    COUNT(DISTINCT oi.order_id)                    AS order_count
  FROM or_order_items oi
  JOIN or_orders o ON o.id = oi.order_id
  JOIN pr_products p ON p.id = oi.product_id
  LEFT JOIN LATERAL (
    SELECT 1 AS hit
    FROM wms_orders w
    WHERE w.stock_action = 'recalled'
      AND w.status = 'cancelled'
      AND (
        w.source_order_item_id = oi.id
        OR (
          w.source_order_item_id IS NULL
          AND trim(both FROM coalesce(w.order_id, '')) = trim(both FROM coalesce(o.work_order_name, ''))
          AND upper(trim(both FROM coalesce(w.product_code, ''))) = upper(trim(both FROM coalesce(p.product_code::text, '')))
        )
      )
    LIMIT 1
  ) recalled_line ON true
  WHERE o.entry_date >= p_from_date
    AND o.entry_date <= p_to_date
    -- นับเฉพาะยอดขายที่ปิดงานแล้วจริง
    AND trim(both FROM coalesce(o.status, '')) IN (
      U&'\0E08\0E31\0E14\0E2A\0E48\0E07\0E41\0E25\0E49\0E27', -- จัดส่งแล้ว
      U&'\0E40\0E2A\0E23\0E47\0E08\0E2A\0E34\0E49\0E19'      -- เสร็จสิ้น
    )
    AND oi.product_id IS NOT NULL
    AND COALESCE(oi.cancellation_stock_action, '') <> 'recalled'
    AND recalled_line.hit IS NULL
  GROUP BY p.id, p.product_code, p.product_name, p.product_type
  ORDER BY total_qty DESC;
$$;

GRANT EXECUTE ON FUNCTION rpc_product_sales_summary(DATE, DATE) TO authenticated;
