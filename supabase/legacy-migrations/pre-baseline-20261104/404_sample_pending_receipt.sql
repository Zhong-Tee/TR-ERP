BEGIN;

-- Allow the receiving team to record an incoming sample before it physically arrives.
DROP FUNCTION IF EXISTS rpc_create_sample(JSONB, TEXT, TEXT, UUID);

CREATE OR REPLACE FUNCTION rpc_create_sample(
  p_items JSONB,
  p_sample_label TEXT,
  p_note TEXT DEFAULT NULL,
  p_user_id UUID DEFAULT NULL,
  p_receipt_status TEXT DEFAULT 'received'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := COALESCE(auth.uid(), p_user_id);
  v_sample_id UUID;
  v_sample_no TEXT;
  v_item JSONB;
BEGIN
  IF COALESCE(trim(p_sample_label), '') = '' THEN
    RAISE EXCEPTION 'กรุณาระบุชื่อเรียกสินค้า';
  END IF;
  IF p_receipt_status NOT IN ('pending_receipt', 'received') THEN
    RAISE EXCEPTION 'สถานะรับสินค้าไม่ถูกต้อง';
  END IF;

  v_sample_no := 'SMP-' || to_char(NOW(), 'YYYYMMDD') || '-' || lpad(floor(random() * 9000 + 1000)::text, 4, '0');

  INSERT INTO inv_samples (sample_no, status, received_by, received_at, sample_label, note)
  VALUES (
    v_sample_no,
    p_receipt_status,
    CASE WHEN p_receipt_status = 'received' THEN v_uid ELSE NULL END,
    CASE WHEN p_receipt_status = 'received' THEN NOW() ELSE NULL END,
    trim(p_sample_label),
    p_note
  )
  RETURNING id INTO v_sample_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO inv_sample_items (sample_id, product_name_manual, image_url, qty, note)
    VALUES (
      v_sample_id,
      NULLIF(trim(v_item->>'product_name_manual'), ''),
      NULLIF(trim(v_item->>'image_url'), ''),
      COALESCE((v_item->>'qty')::NUMERIC, 0),
      NULLIF(trim(v_item->>'note'), '')
    );
  END LOOP;

  RETURN jsonb_build_object('id', v_sample_id, 'sample_no', v_sample_no);
END;
$$;

COMMIT;
