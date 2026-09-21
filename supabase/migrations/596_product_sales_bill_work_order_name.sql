-- Show the work-order reference beside each sales bill so users can trace a
-- sales row directly to WMS review and stock movements.

BEGIN;

-- The OUT row type changes, so PostgreSQL requires a drop before recreation.
DROP FUNCTION IF EXISTS public.rpc_product_sales_bills(UUID, DATE, DATE);

CREATE FUNCTION public.rpc_product_sales_bills(
  p_product_id UUID,
  p_from_date DATE,
  p_to_date DATE
)
RETURNS TABLE(
  order_id UUID,
  bill_no TEXT,
  work_order_name TEXT,
  entry_date DATE,
  order_status TEXT,
  total_qty NUMERIC,
  total_amount NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    o.id AS order_id,
    o.bill_no,
    o.work_order_name,
    o.entry_date,
    o.status AS order_status,
    COALESCE(SUM(oi.quantity), 0) AS total_qty,
    COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS total_amount
  FROM public.or_order_items oi
  JOIN public.or_orders o ON o.id = oi.order_id
  JOIN public.pr_products p ON p.id = oi.product_id
  LEFT JOIN LATERAL (
    SELECT 1 AS hit
    FROM public.wms_orders w
    WHERE w.stock_action = 'recalled'
      AND w.status = 'cancelled'
      AND (
        w.source_order_item_id = oi.id
        OR (
          w.source_order_item_id IS NULL
          AND BTRIM(COALESCE(w.order_id, '')) = BTRIM(COALESCE(o.work_order_name, ''))
          AND UPPER(BTRIM(COALESCE(w.product_code, ''))) = UPPER(BTRIM(COALESCE(p.product_code::TEXT, '')))
        )
      )
    LIMIT 1
  ) recalled_line ON TRUE
  WHERE oi.product_id = p_product_id
    AND o.entry_date >= p_from_date
    AND o.entry_date <= p_to_date
    AND BTRIM(COALESCE(o.status, '')) IN ('จัดส่งแล้ว', 'เสร็จสิ้น')
    AND COALESCE(oi.cancellation_stock_action, '') <> 'recalled'
    AND recalled_line.hit IS NULL
  GROUP BY o.id, o.bill_no, o.work_order_name, o.entry_date, o.status
  ORDER BY o.entry_date DESC, o.bill_no DESC;
$$;

REVOKE ALL ON FUNCTION public.rpc_product_sales_bills(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_product_sales_bills(UUID, DATE, DATE) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
