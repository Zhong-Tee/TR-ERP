-- ============================================
-- RPC: rpc_product_sales_summary
-- สรุปยอดขายแยกตามสินค้า ภายในช่วงวันที่ที่ระบุ
-- ใช้สำหรับหน้า "รายการขายสินค้า" ในหมวดคลัง
-- ============================================

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
    COALESCE(SUM(oi.quantity), 0)              AS total_qty,
    COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS total_amount,
    COUNT(DISTINCT oi.order_id)                AS order_count
  FROM or_order_items oi
  JOIN or_orders   o ON o.id = oi.order_id
  JOIN pr_products p ON p.id = oi.product_id
  WHERE o.entry_date >= p_from_date
    AND o.entry_date <= p_to_date
    AND o.status <> 'ยกเลิก'
    AND oi.product_id IS NOT NULL
  GROUP BY p.id, p.product_code, p.product_name, p.product_type
  ORDER BY total_qty DESC;
$$;

GRANT EXECUTE ON FUNCTION rpc_product_sales_summary(DATE, DATE) TO authenticated;
