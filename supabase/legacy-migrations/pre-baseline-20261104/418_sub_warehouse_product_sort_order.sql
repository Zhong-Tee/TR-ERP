-- Persistent, per-sub-warehouse ordering for assigned products.
ALTER TABLE public.wh_sub_warehouse_products
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY sub_warehouse_id ORDER BY created_at, id)::INTEGER AS position
  FROM public.wh_sub_warehouse_products
)
UPDATE public.wh_sub_warehouse_products product
SET sort_order = ranked.position
FROM ranked
WHERE ranked.id = product.id AND product.sort_order = 0;

CREATE INDEX IF NOT EXISTS idx_wh_sub_warehouse_products_order
  ON public.wh_sub_warehouse_products(sub_warehouse_id, sort_order, created_at);

CREATE OR REPLACE FUNCTION public.set_sub_warehouse_product_sort_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.sort_order <= 0 THEN
    SELECT COALESCE(MAX(sort_order), 0) + 1 INTO NEW.sort_order
    FROM public.wh_sub_warehouse_products
    WHERE sub_warehouse_id = NEW.sub_warehouse_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_sub_warehouse_product_sort_order ON public.wh_sub_warehouse_products;
CREATE TRIGGER set_sub_warehouse_product_sort_order
BEFORE INSERT ON public.wh_sub_warehouse_products
FOR EACH ROW EXECUTE FUNCTION public.set_sub_warehouse_product_sort_order();

CREATE OR REPLACE FUNCTION public.rpc_reorder_sub_warehouse_products(
  p_sub_warehouse_id UUID,
  p_product_ids UUID[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_expected_count INTEGER;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN (
    'superadmin', 'admin', 'sales-tr', 'qc_order', 'sales-pump', 'qc_staff',
    'packing_staff', 'account', 'store', 'production', 'hr'
  ) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์จัดลำดับสินค้าคลังย่อย';
  END IF;

  SELECT count(*) INTO v_expected_count
  FROM public.wh_sub_warehouse_products
  WHERE sub_warehouse_id = p_sub_warehouse_id;

  IF cardinality(p_product_ids) <> v_expected_count
     OR (SELECT count(DISTINCT ordered_pid.pid) FROM unnest(p_product_ids) AS ordered_pid(pid)) <> v_expected_count
     OR EXISTS (
       SELECT 1 FROM unnest(p_product_ids) AS ordered_pid(pid)
       WHERE NOT EXISTS (
         SELECT 1 FROM public.wh_sub_warehouse_products assigned
         WHERE assigned.sub_warehouse_id = p_sub_warehouse_id
           AND assigned.product_id = ordered_pid.pid
       )
     ) THEN
    RAISE EXCEPTION 'รายการสินค้าสำหรับจัดลำดับไม่ครบหรือไม่ถูกต้อง';
  END IF;

  UPDATE public.wh_sub_warehouse_products assigned
  SET sort_order = ordered.position
  FROM unnest(p_product_ids) WITH ORDINALITY AS ordered(product_id, position)
  WHERE assigned.sub_warehouse_id = p_sub_warehouse_id
    AND assigned.product_id = ordered.product_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_reorder_sub_warehouse_products(UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_reorder_sub_warehouse_products(UUID, UUID[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.rpc_get_sub_warehouse_balances(p_sub_warehouse_id UUID)
RETURNS TABLE (
  product_id UUID,
  product_code TEXT,
  product_name TEXT,
  unit_name TEXT,
  qty_on_hand NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.product_code, p.product_name, p.unit_name, COALESCE(balance.qty_on_hand, 0)
  FROM public.wh_sub_warehouse_products assigned
  JOIN public.pr_products p ON p.id = assigned.product_id
  LEFT JOIN public.wh_sub_warehouse_balances balance
    ON balance.sub_warehouse_id = assigned.sub_warehouse_id
   AND balance.product_id = assigned.product_id
  WHERE assigned.sub_warehouse_id = p_sub_warehouse_id
  ORDER BY assigned.sort_order, assigned.created_at, p.product_code;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_get_sub_warehouse_balances(UUID) TO authenticated;
