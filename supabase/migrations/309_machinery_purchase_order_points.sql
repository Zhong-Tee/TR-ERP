-- Expose non-financial reorder information to Machinery catalogue screens.

BEGIN;

DROP FUNCTION IF EXISTS public.get_machinery_purchase_products(boolean);

CREATE FUNCTION public.get_machinery_purchase_products(p_include_disabled boolean DEFAULT false)
RETURNS TABLE (
  product_id uuid,
  product_code text,
  product_name text,
  product_category text,
  unit_name text,
  storage_location text,
  on_hand numeric,
  enabled boolean,
  order_point text,
  order_point_days integer
)
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT p.id, p.product_code, p.product_name, p.product_category, p.unit_name,
         p.storage_location, COALESCE(b.on_hand, 0), COALESCE(mp.enabled, false),
         p.order_point, p.order_point_days
  FROM pr_products p
  LEFT JOIN pr_machinery_purchase_products mp ON mp.product_id = p.id
  LEFT JOIN inv_stock_balances b ON b.product_id = p.id
  WHERE p.is_active = true
    AND (p_include_disabled OR COALESCE(mp.enabled, false))
  ORDER BY p.product_code;
$$;

GRANT EXECUTE ON FUNCTION public.get_machinery_purchase_products(boolean) TO authenticated;

COMMIT;
