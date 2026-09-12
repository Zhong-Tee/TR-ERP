-- Internal production: PP min/max thresholds, role access and server-side max guard.

BEGIN;

ALTER TABLE public.pp_recipes
  ADD COLUMN IF NOT EXISTS min_stock NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS max_stock NUMERIC(14, 2);

ALTER TABLE public.pp_recipes
  DROP CONSTRAINT IF EXISTS pp_recipes_stock_thresholds_check;
ALTER TABLE public.pp_recipes
  ADD CONSTRAINT pp_recipes_stock_thresholds_check
  CHECK (
    (min_stock IS NULL OR min_stock >= 0)
    AND (max_stock IS NULL OR max_stock >= 0)
    AND (min_stock IS NULL OR max_stock IS NULL OR min_stock <= max_stock)
  );

UPDATE public.st_user_menus
SET has_access = false, updated_at = now()
WHERE menu_key = 'warehouse-production'
  AND role NOT IN ('superadmin', 'admin', 'store', 'production', 'account');

INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access)
VALUES
  ('account', 'warehouse', 'คลัง', true),
  ('superadmin', 'warehouse-production', 'ผลิตภายใน', true),
  ('admin', 'warehouse-production', 'ผลิตภายใน', true),
  ('store', 'warehouse-production', 'ผลิตภายใน', true),
  ('production', 'warehouse-production', 'ผลิตภายใน', true),
  ('account', 'warehouse-production', 'ผลิตภายใน', true)
ON CONFLICT (role, menu_key) DO UPDATE SET
  menu_name = EXCLUDED.menu_name,
  has_access = EXCLUDED.has_access,
  updated_at = now();

DROP POLICY IF EXISTS "pp_recipes read" ON public.pp_recipes;
CREATE POLICY "pp_recipes read" ON public.pp_recipes FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.us_users
  WHERE id = auth.uid() AND is_active IS TRUE
    AND role IN ('superadmin', 'admin', 'store', 'production', 'account')
));

DROP POLICY IF EXISTS "pp_recipes write" ON public.pp_recipes;
CREATE POLICY "pp_recipes write" ON public.pp_recipes FOR ALL TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.us_users
  WHERE id = auth.uid() AND is_active IS TRUE AND role IN ('superadmin', 'admin')
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.us_users
  WHERE id = auth.uid() AND is_active IS TRUE AND role IN ('superadmin', 'admin')
));

DROP POLICY IF EXISTS "pp_recipe_includes read" ON public.pp_recipe_includes;
CREATE POLICY "pp_recipe_includes read" ON public.pp_recipe_includes FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.us_users WHERE id = auth.uid() AND is_active IS TRUE
    AND role IN ('superadmin', 'admin', 'store', 'production', 'account')
));
DROP POLICY IF EXISTS "pp_recipe_includes write" ON public.pp_recipe_includes;
CREATE POLICY "pp_recipe_includes write" ON public.pp_recipe_includes FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.us_users WHERE id = auth.uid() AND is_active IS TRUE AND role IN ('superadmin', 'admin')))
WITH CHECK (EXISTS (SELECT 1 FROM public.us_users WHERE id = auth.uid() AND is_active IS TRUE AND role IN ('superadmin', 'admin')));

DROP POLICY IF EXISTS "pp_recipe_removes read" ON public.pp_recipe_removes;
CREATE POLICY "pp_recipe_removes read" ON public.pp_recipe_removes FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.us_users WHERE id = auth.uid() AND is_active IS TRUE
    AND role IN ('superadmin', 'admin', 'store', 'production', 'account')
));
DROP POLICY IF EXISTS "pp_recipe_removes write" ON public.pp_recipe_removes;
CREATE POLICY "pp_recipe_removes write" ON public.pp_recipe_removes FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.us_users WHERE id = auth.uid() AND is_active IS TRUE AND role IN ('superadmin', 'admin')))
WITH CHECK (EXISTS (SELECT 1 FROM public.us_users WHERE id = auth.uid() AND is_active IS TRUE AND role IN ('superadmin', 'admin')));

DROP POLICY IF EXISTS "pp_production_orders read" ON public.pp_production_orders;
CREATE POLICY "pp_production_orders read" ON public.pp_production_orders FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.us_users WHERE id = auth.uid() AND is_active IS TRUE
    AND role IN ('superadmin', 'admin', 'store', 'production', 'account')
));
DROP POLICY IF EXISTS "pp_production_order_items read" ON public.pp_production_order_items;
CREATE POLICY "pp_production_order_items read" ON public.pp_production_order_items FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.us_users WHERE id = auth.uid() AND is_active IS TRUE
    AND role IN ('superadmin', 'admin', 'store', 'production', 'account')
));

CREATE OR REPLACE FUNCTION public.guard_pp_production_max_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_over record;
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'approved' THEN
    SELECT p.product_code, COALESCE(b.on_hand, 0) AS on_hand, r.max_stock
      INTO v_over
    FROM public.pp_production_order_items oi
    JOIN public.pp_recipes r ON r.product_id = oi.product_id
    JOIN public.pr_products p ON p.id = oi.product_id
    LEFT JOIN public.inv_stock_balances b ON b.product_id = oi.product_id
    WHERE oi.order_id = NEW.id
      AND r.max_stock IS NOT NULL
      AND COALESCE(b.on_hand, 0) > r.max_stock
    LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'สินค้า % จะมีคงเหลือ % เกิน Max %',
        v_over.product_code, v_over.on_hand, v_over.max_stock;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_pp_production_max_stock ON public.pp_production_orders;
CREATE TRIGGER trg_guard_pp_production_max_stock
  BEFORE UPDATE OF status ON public.pp_production_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_pp_production_max_stock();

COMMIT;
