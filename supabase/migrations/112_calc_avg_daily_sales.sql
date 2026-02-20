-- ============================================
-- RPC: calc_avg_daily_sales
-- คำนวณยอดขายรวมต่อสินค้า ตั้งแต่วันที่ที่ระบุจนถึงปัจจุบัน
-- ใช้สำหรับคำนวณ "วันขายคงเหลือ" ในหน้าคลังสินค้า
-- ============================================

CREATE OR REPLACE FUNCTION calc_avg_daily_sales(p_from_date DATE)
RETURNS TABLE(product_id UUID, total_sold NUMERIC)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT
    oi.product_id,
    SUM(oi.quantity)::NUMERIC AS total_sold
  FROM or_order_items oi
  JOIN or_orders o ON o.id = oi.order_id
  WHERE o.entry_date >= p_from_date
    AND o.status NOT IN ('ยกเลิก')
    AND oi.product_id IS NOT NULL
  GROUP BY oi.product_id;
$$;

GRANT EXECUTE ON FUNCTION calc_avg_daily_sales(DATE) TO authenticated;
