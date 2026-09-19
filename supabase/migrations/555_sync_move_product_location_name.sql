-- Keep the legacy product storage_location column aligned with the
-- product-specific display name configured for the MOVE storage bucket.

BEGIN;

UPDATE public.pr_products product
SET storage_location = label.display_name,
    updated_at = NOW()
FROM public.wh_product_location_labels label
JOIN public.wh_storage_locations location
  ON location.id = label.location_id
WHERE label.product_id = product.id
  AND label.label_type = 'storage'
  AND LOWER(BTRIM(location.code)) = 'move';

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
  v_move_location_id UUID;
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

  SELECT id INTO v_move_location_id
  FROM public.wh_storage_locations
  WHERE LOWER(BTRIM(code)) = 'move'
  LIMIT 1;

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

    IF v_type = 'movement'
       OR (v_type = 'storage' AND v_location_id = v_move_location_id) THEN
      v_movement_name := v_name;
    END IF;
  END LOOP;

  UPDATE public.pr_products
  SET storage_location = v_movement_name,
      updated_at = NOW()
  WHERE id = p_product_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_set_product_location_labels(UUID,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_set_product_location_labels(UUID,JSONB) TO authenticated;

COMMENT ON FUNCTION public.rpc_set_product_location_labels(UUID,JSONB) IS
  'Replaces product-specific storage labels and syncs the MOVE label to pr_products.storage_location.';

COMMIT;
