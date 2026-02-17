-- RPC สำหรับดึง product_category ที่ไม่ซ้ำ แทนการ SELECT ทุกแถวแล้วมา dedupe ใน JS
CREATE OR REPLACE FUNCTION get_distinct_product_categories()
RETURNS TABLE(product_category TEXT)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT DISTINCT p.product_category
  FROM pr_products p
  WHERE p.is_active = true
    AND p.product_category IS NOT NULL
    AND p.product_category <> ''
  ORDER BY p.product_category;
$$;

-- อนุญาตให้ authenticated users เรียกใช้ได้
GRANT EXECUTE ON FUNCTION get_distinct_product_categories() TO authenticated;
