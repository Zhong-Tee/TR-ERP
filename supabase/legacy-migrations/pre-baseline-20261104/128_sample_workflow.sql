-- ============================================
-- 128: Sample Workflow Upgrade
-- Status flow: received -> testing -> approved/rejected -> converted
-- ============================================

-- 1. Add test/convert columns to inv_samples
ALTER TABLE inv_samples ADD COLUMN IF NOT EXISTS tested_by UUID;
ALTER TABLE inv_samples ADD COLUMN IF NOT EXISTS tested_at TIMESTAMPTZ;
ALTER TABLE inv_samples ADD COLUMN IF NOT EXISTS test_result TEXT;
ALTER TABLE inv_samples ADD COLUMN IF NOT EXISTS test_note TEXT;
ALTER TABLE inv_samples ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- 2. Add test/convert columns to inv_sample_items
ALTER TABLE inv_sample_items ADD COLUMN IF NOT EXISTS converted_product_id UUID REFERENCES pr_products(id);
ALTER TABLE inv_sample_items ADD COLUMN IF NOT EXISTS item_test_result TEXT;
ALTER TABLE inv_sample_items ADD COLUMN IF NOT EXISTS item_test_note TEXT;

-- 3. RPC: Update sample test result
CREATE OR REPLACE FUNCTION rpc_update_sample_test(
  p_sample_id UUID,
  p_status TEXT,
  p_user_id UUID DEFAULT NULL,
  p_test_note TEXT DEFAULT NULL,
  p_rejection_reason TEXT DEFAULT NULL,
  p_item_results JSONB DEFAULT '[]'::JSONB
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_item JSONB;
BEGIN
  IF p_status NOT IN ('testing', 'approved', 'rejected') THEN
    RAISE EXCEPTION 'สถานะไม่ถูกต้อง: %', p_status;
  END IF;

  UPDATE inv_samples
  SET status = p_status,
      tested_by = CASE WHEN p_status IN ('approved', 'rejected') THEN p_user_id ELSE tested_by END,
      tested_at = CASE WHEN p_status IN ('approved', 'rejected') THEN NOW() ELSE tested_at END,
      test_result = CASE WHEN p_status = 'approved' THEN 'passed' WHEN p_status = 'rejected' THEN 'failed' ELSE test_result END,
      test_note = COALESCE(p_test_note, test_note),
      rejection_reason = CASE WHEN p_status = 'rejected' THEN p_rejection_reason ELSE rejection_reason END
  WHERE id = p_sample_id;

  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบ Sample'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_item_results)
  LOOP
    UPDATE inv_sample_items
    SET item_test_result = v_item->>'result',
        item_test_note = v_item->>'note'
    WHERE id = (v_item->>'item_id')::UUID AND sample_id = p_sample_id;
  END LOOP;
END;
$$;

-- 4. RPC: Convert sample item to product
CREATE OR REPLACE FUNCTION rpc_convert_sample_to_product(
  p_sample_id UUID,
  p_item_id UUID,
  p_product_code TEXT,
  p_product_name TEXT,
  p_product_name_cn TEXT DEFAULT NULL,
  p_product_type TEXT DEFAULT 'FG',
  p_product_category TEXT DEFAULT NULL,
  p_seller_name TEXT DEFAULT NULL,
  p_unit_cost NUMERIC DEFAULT NULL,
  p_user_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_product_id UUID;
  v_all_converted BOOLEAN;
BEGIN
  INSERT INTO pr_products (product_code, product_name, product_name_cn, product_type, product_category, seller_name, unit_cost, is_active)
  VALUES (p_product_code, p_product_name, p_product_name_cn, p_product_type, p_product_category, p_seller_name, p_unit_cost, true)
  RETURNING id INTO v_product_id;

  UPDATE inv_sample_items
  SET converted_product_id = v_product_id
  WHERE id = p_item_id AND sample_id = p_sample_id;

  SELECT bool_and(converted_product_id IS NOT NULL)
  INTO v_all_converted
  FROM inv_sample_items
  WHERE sample_id = p_sample_id;

  IF v_all_converted THEN
    UPDATE inv_samples SET status = 'converted' WHERE id = p_sample_id;
  END IF;

  RETURN v_product_id;
END;
$$;
