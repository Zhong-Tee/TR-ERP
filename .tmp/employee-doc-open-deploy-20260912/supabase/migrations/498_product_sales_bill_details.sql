-- Drill-down รายการบิลของสินค้าในรายงานรายการขายสินค้า
-- ใช้เงื่อนไขเดียวกับ rpc_product_sales_summary เพื่อให้ยอดและจำนวนบิลตรงกัน
CREATE OR REPLACE FUNCTION public.rpc_product_sales_bills(
  p_product_id UUID,
  p_from_date DATE,
  p_to_date DATE
)
RETURNS TABLE(
  order_id UUID,
  bill_no TEXT,
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
          AND trim(both FROM coalesce(w.order_id, '')) = trim(both FROM coalesce(o.work_order_name, ''))
          AND upper(trim(both FROM coalesce(w.product_code, ''))) = upper(trim(both FROM coalesce(p.product_code::text, '')))
        )
      )
    LIMIT 1
  ) recalled_line ON true
  WHERE oi.product_id = p_product_id
    AND o.entry_date >= p_from_date
    AND o.entry_date <= p_to_date
    AND trim(both FROM coalesce(o.status, '')) IN ('จัดส่งแล้ว', 'เสร็จสิ้น')
    AND COALESCE(oi.cancellation_stock_action, '') <> 'recalled'
    AND recalled_line.hit IS NULL
  GROUP BY o.id, o.bill_no, o.entry_date, o.status
  ORDER BY o.entry_date DESC, o.bill_no DESC;
$$;

REVOKE ALL ON FUNCTION public.rpc_product_sales_bills(UUID, DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_product_sales_bills(UUID, DATE, DATE) TO authenticated;
