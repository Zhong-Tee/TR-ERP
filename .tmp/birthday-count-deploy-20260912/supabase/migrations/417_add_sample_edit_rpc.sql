-- Edit a sample and its item list with an explicit server-side role check.
CREATE OR REPLACE FUNCTION public.rpc_update_sample(
  p_sample_id UUID,
  p_items JSONB,
  p_sample_label TEXT,
  p_note TEXT DEFAULT NULL,
  p_receipt_status TEXT DEFAULT 'received'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_item JSONB;
  v_item_id UUID;
  v_keep_ids UUID[] := ARRAY[]::UUID[];
  v_current_status TEXT;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'store', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไขสินค้าตัวอย่าง';
  END IF;
  IF COALESCE(trim(p_sample_label), '') = '' OR jsonb_array_length(COALESCE(p_items, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'ต้องระบุสินค้าอย่างน้อย 1 รายการ';
  END IF;
  IF p_receipt_status NOT IN ('pending_receipt', 'received') THEN
    RAISE EXCEPTION 'สถานะการรับสินค้าไม่ถูกต้อง';
  END IF;

  SELECT status INTO v_current_status FROM public.inv_samples WHERE id = p_sample_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบสินค้าตัวอย่าง'; END IF;

  UPDATE public.inv_samples
  SET sample_label = trim(p_sample_label), note = NULLIF(trim(p_note), ''),
      status = CASE WHEN v_current_status IN ('pending_receipt', 'received') THEN p_receipt_status ELSE v_current_status END,
      received_at = CASE WHEN v_current_status IN ('pending_receipt', 'received') AND p_receipt_status = 'received' THEN COALESCE(received_at, now()) WHEN p_receipt_status = 'pending_receipt' THEN NULL ELSE received_at END,
      received_by = CASE WHEN v_current_status IN ('pending_receipt', 'received') AND p_receipt_status = 'received' THEN COALESCE(received_by, auth.uid()) WHEN p_receipt_status = 'pending_receipt' THEN NULL ELSE received_by END
  WHERE id = p_sample_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_item_id := NULLIF(v_item->>'id', '')::UUID;
    IF v_item_id IS NULL THEN
      INSERT INTO public.inv_sample_items (sample_id, product_name_manual, image_url, qty, note)
      VALUES (p_sample_id, trim(v_item->>'product_name_manual'), NULLIF(v_item->>'image_url', ''), GREATEST(COALESCE((v_item->>'qty')::NUMERIC, 1), 1), NULLIF(trim(v_item->>'note'), ''))
      RETURNING id INTO v_item_id;
    ELSE
      UPDATE public.inv_sample_items
      SET product_name_manual = trim(v_item->>'product_name_manual'), image_url = NULLIF(v_item->>'image_url', ''), qty = GREATEST(COALESCE((v_item->>'qty')::NUMERIC, 1), 1), note = NULLIF(trim(v_item->>'note'), '')
      WHERE id = v_item_id AND sample_id = p_sample_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'รายการสินค้าไม่ถูกต้อง'; END IF;
    END IF;
    v_keep_ids := array_append(v_keep_ids, v_item_id);
  END LOOP;

  DELETE FROM public.inv_sample_items
  WHERE sample_id = p_sample_id AND NOT (id = ANY(v_keep_ids)) AND converted_product_id IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_update_sample(UUID, JSONB, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_update_sample(UUID, JSONB, TEXT, TEXT, TEXT) TO authenticated;
