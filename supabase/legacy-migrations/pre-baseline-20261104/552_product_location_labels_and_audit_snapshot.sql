-- Product-specific display names for Movement, physical storage points and Safety stock.
-- Quantities remain owned by inv_stock_balances / wh_location_stock; this table stores labels only.

BEGIN;

CREATE TABLE IF NOT EXISTS public.wh_product_location_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES public.pr_products(id) ON DELETE CASCADE,
  label_type TEXT NOT NULL CHECK (label_type IN ('movement', 'storage', 'safety')),
  location_id UUID REFERENCES public.wh_storage_locations(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK (NULLIF(BTRIM(display_name), '') IS NOT NULL),
  updated_by UUID REFERENCES public.us_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (label_type = 'storage' AND location_id IS NOT NULL)
    OR (label_type IN ('movement', 'safety') AND location_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wh_product_location_bucket
  ON public.wh_product_location_labels(product_id, label_type)
  WHERE label_type IN ('movement', 'safety');

CREATE UNIQUE INDEX IF NOT EXISTS uq_wh_product_location_storage
  ON public.wh_product_location_labels(product_id, location_id)
  WHERE label_type = 'storage';

CREATE INDEX IF NOT EXISTS idx_wh_product_location_labels_product
  ON public.wh_product_location_labels(product_id);

ALTER TABLE public.wh_product_location_labels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Product location labels readable" ON public.wh_product_location_labels;
CREATE POLICY "Product location labels readable"
  ON public.wh_product_location_labels FOR SELECT TO authenticated USING (true);

REVOKE INSERT, UPDATE, DELETE ON public.wh_product_location_labels FROM authenticated;
GRANT SELECT ON public.wh_product_location_labels TO authenticated;

CREATE OR REPLACE FUNCTION public.can_manage_product_location_labels()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.us_users
    WHERE id = auth.uid()
      AND role IN (
        'superadmin', 'admin', 'admin-tr', 'admin-pump',
        'sales-tr', 'sales-pump', 'store', 'account', 'auditor'
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.rpc_get_product_location_labels(p_product_id UUID)
RETURNS TABLE(
  label_type TEXT,
  location_id UUID,
  code TEXT,
  default_name TEXT,
  display_name TEXT,
  configured_name TEXT,
  qty NUMERIC,
  sort_order INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH product_row AS (
    SELECT id, NULLIF(BTRIM(storage_location), '') AS legacy_location
    FROM public.pr_products
    WHERE id = p_product_id
  )
  SELECT
    'movement'::TEXT,
    NULL::UUID,
    'MOVEMENT'::TEXT,
    'Movement'::TEXT,
    COALESCE(label.display_name, product_row.legacy_location, 'Movement')::TEXT,
    label.display_name::TEXT,
    COALESCE(balance.on_hand, 0)::NUMERIC,
    -200
  FROM product_row
  LEFT JOIN public.wh_product_location_labels label
    ON label.product_id = product_row.id AND label.label_type = 'movement'
  LEFT JOIN public.inv_stock_balances balance ON balance.product_id = product_row.id

  UNION ALL

  SELECT
    'storage'::TEXT,
    location.id,
    location.code::TEXT,
    COALESCE(NULLIF(BTRIM(location.name), ''), location.code)::TEXT,
    COALESCE(label.display_name, NULLIF(BTRIM(location.name), ''), location.code)::TEXT,
    label.display_name::TEXT,
    COALESCE(stock.qty, 0)::NUMERIC,
    location.sort_order
  FROM public.wh_storage_locations location
  CROSS JOIN product_row
  LEFT JOIN public.wh_product_location_labels label
    ON label.product_id = product_row.id
   AND label.label_type = 'storage'
   AND label.location_id = location.id
  LEFT JOIN public.wh_location_stock stock
    ON stock.product_id = product_row.id AND stock.location_id = location.id
  WHERE location.is_active

  UNION ALL

  SELECT
    'safety'::TEXT,
    NULL::UUID,
    'SAFETY'::TEXT,
    'Safety stock'::TEXT,
    COALESCE(label.display_name, 'Safety stock')::TEXT,
    label.display_name::TEXT,
    COALESCE(balance.safety_stock, 0)::NUMERIC,
    2000000000
  FROM product_row
  LEFT JOIN public.wh_product_location_labels label
    ON label.product_id = product_row.id AND label.label_type = 'safety'
  LEFT JOIN public.inv_stock_balances balance ON balance.product_id = product_row.id

  -- UNION output columns must be referenced by output position here.
  ORDER BY 8, 3;
$$;

CREATE OR REPLACE FUNCTION public.rpc_set_product_location_labels(
  p_product_id UUID,
  p_labels JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item JSONB;
  v_type TEXT;
  v_location_id UUID;
  v_name TEXT;
  v_movement_name TEXT;
BEGIN
  IF NOT public.can_manage_product_location_labels() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไขชื่อจุดจัดเก็บสินค้า';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pr_products WHERE id = p_product_id) THEN
    RAISE EXCEPTION 'ไม่พบสินค้า';
  END IF;
  IF p_labels IS NULL OR jsonb_typeof(p_labels) <> 'array' THEN
    RAISE EXCEPTION 'รูปแบบข้อมูลจุดจัดเก็บไม่ถูกต้อง';
  END IF;

  DELETE FROM public.wh_product_location_labels WHERE product_id = p_product_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_labels)
  LOOP
    v_type := NULLIF(BTRIM(v_item->>'label_type'), '');
    v_name := NULLIF(BTRIM(v_item->>'display_name'), '');
    v_location_id := NULLIF(v_item->>'location_id', '')::UUID;

    IF v_name IS NULL THEN CONTINUE; END IF;
    IF v_type NOT IN ('movement', 'storage', 'safety') THEN
      RAISE EXCEPTION 'ประเภทจุดจัดเก็บไม่ถูกต้อง';
    END IF;
    IF v_type = 'storage' AND (
      v_location_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.wh_storage_locations WHERE id = v_location_id
      )
    ) THEN
      RAISE EXCEPTION 'ไม่พบจุดจัดเก็บที่เลือก';
    END IF;

    INSERT INTO public.wh_product_location_labels(
      product_id, label_type, location_id, display_name, updated_by
    ) VALUES (
      p_product_id,
      v_type,
      CASE WHEN v_type = 'storage' THEN v_location_id ELSE NULL END,
      v_name,
      auth.uid()
    );

    IF v_type = 'movement' THEN v_movement_name := v_name; END IF;
  END LOOP;

  -- Keep old integrations readable while the new structured labels are adopted.
  UPDATE public.pr_products
  SET storage_location = v_movement_name, updated_at = NOW()
  WHERE id = p_product_id AND v_movement_name IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_update_product_location_label(
  p_product_id UUID,
  p_label_type TEXT,
  p_location_id UUID,
  p_display_name TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_name TEXT := NULLIF(BTRIM(p_display_name), '');
BEGIN
  IF NOT public.can_manage_product_location_labels() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไขชื่อจุดจัดเก็บสินค้า';
  END IF;
  IF p_label_type NOT IN ('movement', 'storage', 'safety') OR v_name IS NULL THEN
    RAISE EXCEPTION 'ข้อมูลชื่อจุดจัดเก็บไม่ถูกต้อง';
  END IF;
  IF p_label_type = 'storage' AND (
    p_location_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.wh_storage_locations WHERE id = p_location_id
    )
  ) THEN
    RAISE EXCEPTION 'ไม่พบจุดจัดเก็บที่เลือก';
  END IF;

  DELETE FROM public.wh_product_location_labels
  WHERE product_id = p_product_id
    AND label_type = p_label_type
    AND (
      (p_label_type = 'storage' AND location_id = p_location_id)
      OR (p_label_type <> 'storage' AND location_id IS NULL)
    );

  INSERT INTO public.wh_product_location_labels(
    product_id, label_type, location_id, display_name, updated_by
  ) VALUES (
    p_product_id,
    p_label_type,
    CASE WHEN p_label_type = 'storage' THEN p_location_id ELSE NULL END,
    v_name,
    auth.uid()
  );

  IF p_label_type = 'movement' THEN
    UPDATE public.pr_products
    SET storage_location = v_name, updated_at = NOW()
    WHERE id = p_product_id;
  END IF;
END;
$$;

-- Return the product-specific name while retaining the existing RPC contract.
CREATE OR REPLACE FUNCTION public.rpc_get_product_location_summary(p_product_id UUID)
RETURNS TABLE(location_id UUID, code TEXT, name TEXT, location_type TEXT, qty NUMERIC)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    location.id,
    location.code,
    COALESCE(label.display_name, location.name),
    location.location_type,
    COALESCE(stock.qty, 0)
  FROM public.wh_storage_locations location
  LEFT JOIN public.wh_location_stock stock
    ON stock.location_id = location.id AND stock.product_id = p_product_id
  LEFT JOIN public.wh_product_location_labels label
    ON label.product_id = p_product_id
   AND label.label_type = 'storage'
   AND label.location_id = location.id
  WHERE location.is_active AND COALESCE(stock.qty, 0) <> 0
  ORDER BY CASE location.location_type WHEN 'picking' THEN 0 WHEN 'reserve' THEN 1 WHEN 'hold' THEN 2 ELSE 3 END,
           location.sort_order, location.code;
$$;

ALTER TABLE public.inv_audit_items
  ADD COLUMN IF NOT EXISTS location_snapshot JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS actual_location_key TEXT;

ALTER TABLE public.inv_audit_count_logs
  ADD COLUMN IF NOT EXISTS actual_location_key TEXT;

REVOKE ALL ON FUNCTION public.can_manage_product_location_labels() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_get_product_location_labels(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_set_product_location_labels(UUID,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_update_product_location_label(UUID,TEXT,UUID,TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.can_manage_product_location_labels() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_product_location_labels(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_set_product_location_labels(UUID,JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_product_location_label(UUID,TEXT,UUID,TEXT) TO authenticated;

COMMENT ON TABLE public.wh_product_location_labels IS
  'Product-specific display labels only; stock quantities remain in inv_stock_balances and wh_location_stock.';
COMMENT ON COLUMN public.inv_audit_items.location_snapshot IS
  'Frozen Movement, physical location and Safety labels/quantities captured when the audit starts.';

COMMIT;
