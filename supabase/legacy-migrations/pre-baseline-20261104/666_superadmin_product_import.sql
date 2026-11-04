-- Keep cost column grants and masked views unchanged. Only this guarded write
-- runs with owner privileges; it returns counts, never product/cost records.
BEGIN;
CREATE FUNCTION public.rpc_import_products(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  item jsonb;
  product public.pr_products%ROWTYPE;
  v_id uuid;
  v_inserted integer := 0;
  v_updated integer := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid() AND role = 'superadmin' AND is_active IS TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'เฉพาะ superadmin ที่เปิดใช้งานเท่านั้นที่นำเข้าสินค้าได้';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'ข้อมูลนำเข้าต้องเป็นรายการสินค้า';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) x
    GROUP BY lower(btrim(x->>'product_code')) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'รหัสสินค้าซ้ำในรายการนำเข้า';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_items) ORDER BY value->>'product_code' LOOP
    -- Whitelist writable fields below; payload IDs and stock/cost metadata
    -- cannot overwrite existing records outside the import template.
    product := jsonb_populate_record(NULL::public.pr_products, item);
    product.product_code := btrim(product.product_code);
    product.product_name := btrim(product.product_name);
    product.product_type := coalesce(nullif(product.product_type, ''), 'FG');
    product.unit_name := coalesce(nullif(btrim(product.unit_name), ''), 'ชิ้น');
    product.unit_multiplier := coalesce(product.unit_multiplier, 1);
    product.unit_cost := coalesce(product.unit_cost, 0);
    IF coalesce(product.product_code, '') = '' OR coalesce(product.product_name, '') = ''
      OR product.product_type NOT IN ('FG', 'RM', 'PP')
      OR product.unit_multiplier <= 0 OR product.unit_cost < 0
      OR product.unit_cost::text IN ('NaN', 'Infinity', '-Infinity')
      OR product.unit_multiplier::text IN ('NaN', 'Infinity', '-Infinity')
      OR product.order_point_days < 0 THEN
      RAISE EXCEPTION 'ข้อมูลสินค้าไม่ถูกต้อง: %', product.product_code;
    END IF;
    IF jsonb_typeof(item->'channel_prices') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'ราคาช่องทางไม่ถูกต้อง: %', product.product_code;
    END IF;
    v_id := NULL;
    INSERT INTO public.pr_products (
      product_code, product_name, seller_name, product_name_cn, order_point,
      order_point_days, product_category, product_type, rubber_code,
      storage_location, unit_cost, unit_name, unit_multiplier, is_active
    ) VALUES (
      product.product_code, product.product_name, product.seller_name, product.product_name_cn,
      product.order_point, product.order_point_days, product.product_category, product.product_type,
      product.rubber_code, product.storage_location, product.unit_cost, product.unit_name,
      product.unit_multiplier, true
    ) ON CONFLICT (product_code) DO NOTHING RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      v_inserted := v_inserted + 1;
    ELSE
      UPDATE public.pr_products SET
        product_name = product.product_name, seller_name = product.seller_name,
        product_name_cn = product.product_name_cn, order_point = product.order_point,
        order_point_days = product.order_point_days, product_category = product.product_category,
        product_type = product.product_type, rubber_code = product.rubber_code,
        storage_location = product.storage_location, unit_cost = product.unit_cost,
        unit_name = product.unit_name, unit_multiplier = product.unit_multiplier
      WHERE product_code = product.product_code RETURNING id INTO v_id;
      v_updated := v_updated + 1;
    END IF;
    DELETE FROM public.pr_product_channel_prices WHERE product_id = v_id;
    INSERT INTO public.pr_product_channel_prices (product_id, channel_code, sale_price)
      SELECT v_id, key, value::numeric FROM jsonb_each_text(item->'channel_prices');
  END LOOP;
  RETURN jsonb_build_object('inserted', v_inserted, 'updated', v_updated);
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_import_products(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_import_products(jsonb) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
