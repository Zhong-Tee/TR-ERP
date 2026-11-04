-- RPC: ดึงสินค้าที่ไม่มีคำสั่งซื้อตั้งแต่วันที่กำหนดจนถึงปัจจุบัน
-- p_from_date: วันที่เริ่มต้น (ถ้าไม่ระบุจะคำนวณจาก p_days)
-- p_days: จำนวนวันย้อนหลัง (ใช้เมื่อไม่ระบุ p_from_date)
CREATE OR REPLACE FUNCTION get_inactive_products(
  p_days INTEGER DEFAULT 30,
  p_from_date DATE DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  product_code TEXT,
  product_name TEXT,
  product_type TEXT,
  product_category TEXT,
  seller_name TEXT,
  storage_location TEXT,
  order_point TEXT,
  rubber_code TEXT,
  last_sold_at TIMESTAMPTZ
) AS $$
DECLARE
  v_cutoff TIMESTAMPTZ;
BEGIN
  IF p_from_date IS NOT NULL THEN
    v_cutoff := p_from_date::TIMESTAMPTZ;
  ELSE
    v_cutoff := NOW() - (p_days || ' days')::INTERVAL;
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.product_code,
    p.product_name,
    p.product_type::TEXT,
    p.product_category,
    p.seller_name,
    p.storage_location,
    p.order_point,
    p.rubber_code,
    (
      SELECT MAX(o.created_at)
      FROM or_order_items oi
      JOIN or_orders o ON o.id = oi.order_id
      WHERE oi.product_id = p.id
    ) AS last_sold_at
  FROM pr_products p
  WHERE p.is_active = true
    AND NOT EXISTS (
      SELECT 1
      FROM or_order_items oi
      JOIN or_orders o ON o.id = oi.order_id
      WHERE oi.product_id = p.id
        AND o.created_at >= v_cutoff
    )
  ORDER BY p.product_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
