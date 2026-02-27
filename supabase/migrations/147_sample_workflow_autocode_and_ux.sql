BEGIN;

-- Sample header fields for clearer workflow tracking
ALTER TABLE inv_samples ADD COLUMN IF NOT EXISTS sample_label TEXT;
ALTER TABLE inv_samples ADD COLUMN IF NOT EXISTS testing_by_name TEXT;
ALTER TABLE inv_samples ADD COLUMN IF NOT EXISTS testing_started_by UUID REFERENCES us_users(id);
ALTER TABLE inv_samples ADD COLUMN IF NOT EXISTS testing_started_at TIMESTAMPTZ;
ALTER TABLE inv_samples ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES us_users(id);
ALTER TABLE inv_samples ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

-- Sample item photo support
ALTER TABLE inv_sample_items ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Keep sample label required for future rows (legacy rows can remain null)
ALTER TABLE inv_samples ALTER COLUMN sample_label SET DEFAULT '';

-- Update Sample create RPC (manual sample names only, with sample label)
DROP FUNCTION IF EXISTS rpc_create_sample(JSONB, TEXT, TEXT, UUID);
CREATE OR REPLACE FUNCTION rpc_create_sample(
  p_items JSONB,
  p_sample_label TEXT,
  p_note TEXT DEFAULT NULL,
  p_user_id UUID DEFAULT NULL
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

  v_sample_no := 'SMP-' || to_char(NOW(), 'YYYYMMDD') || '-' || lpad(floor(random() * 9000 + 1000)::text, 4, '0');

  INSERT INTO inv_samples (sample_no, status, received_by, received_at, sample_label, note)
  VALUES (v_sample_no, 'received', v_uid, NOW(), trim(p_sample_label), p_note)
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

-- Update testing RPC:
-- - testing: requires tester name and stamps testing starter fields
-- - approved/rejected: stamps approver fields
CREATE OR REPLACE FUNCTION rpc_update_sample_test(
  p_sample_id UUID,
  p_status TEXT,
  p_user_id UUID DEFAULT NULL,
  p_testing_by_name TEXT DEFAULT NULL,
  p_test_note TEXT DEFAULT NULL,
  p_rejection_reason TEXT DEFAULT NULL,
  p_item_results JSONB DEFAULT '[]'::JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_uid  UUID := COALESCE(auth.uid(), p_user_id);
  v_item JSONB;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin-tr', 'manager', 'store', 'admin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ทดสอบ Sample (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  IF p_status NOT IN ('testing', 'approved', 'rejected') THEN
    RAISE EXCEPTION 'สถานะไม่ถูกต้อง: %', p_status;
  END IF;

  IF p_status = 'testing' AND COALESCE(trim(p_testing_by_name), '') = '' THEN
    RAISE EXCEPTION 'กรุณาระบุผู้ทดสอบ';
  END IF;

  UPDATE inv_samples
  SET status = p_status,
      testing_by_name = CASE WHEN p_status = 'testing' THEN trim(p_testing_by_name) ELSE testing_by_name END,
      testing_started_by = CASE WHEN p_status = 'testing' THEN v_uid ELSE testing_started_by END,
      testing_started_at = CASE WHEN p_status = 'testing' THEN NOW() ELSE testing_started_at END,
      tested_by = CASE WHEN p_status IN ('approved', 'rejected') THEN v_uid ELSE tested_by END,
      tested_at = CASE WHEN p_status IN ('approved', 'rejected') THEN NOW() ELSE tested_at END,
      approved_by = CASE WHEN p_status = 'approved' THEN v_uid ELSE approved_by END,
      approved_at = CASE WHEN p_status = 'approved' THEN NOW() ELSE approved_at END,
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

-- Convert sample to product:
-- remove unit_cost from this flow; FIFO cost will come from GR later
DROP FUNCTION IF EXISTS rpc_convert_sample_to_product(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID);
CREATE OR REPLACE FUNCTION rpc_convert_sample_to_product(
  p_sample_id UUID,
  p_item_id UUID,
  p_product_code TEXT,
  p_product_name TEXT,
  p_product_name_cn TEXT DEFAULT NULL,
  p_product_type TEXT DEFAULT 'FG',
  p_product_category TEXT DEFAULT NULL,
  p_seller_name TEXT DEFAULT NULL,
  p_user_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_uid UUID := COALESCE(auth.uid(), p_user_id);
  v_product_id UUID;
  v_all_converted BOOLEAN;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin-tr', 'manager', 'store', 'admin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แปลง Sample เป็นสินค้า (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  INSERT INTO pr_products (product_code, product_name, product_name_cn, product_type, product_category, seller_name, is_active)
  VALUES (p_product_code, p_product_name, p_product_name_cn, p_product_type, p_product_category, p_seller_name, true)
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

-- Auto-run next product code by type prefix
CREATE OR REPLACE FUNCTION rpc_get_next_product_code(p_product_type TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefix TEXT;
  v_max_code BIGINT;
  v_next BIGINT;
BEGIN
  v_prefix := CASE UPPER(p_product_type)
    WHEN 'FG' THEN '11'
    WHEN 'RM' THEN '99'
    ELSE NULL
  END;

  IF v_prefix IS NULL THEN
    RAISE EXCEPTION 'รองรับเฉพาะ FG/RM';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('rpc_get_next_product_code:' || v_prefix));

  SELECT MAX(product_code::BIGINT)
  INTO v_max_code
  FROM pr_products
  WHERE product_code ~ '^[0-9]+$'
    AND LEFT(product_code, 2) = v_prefix;

  IF v_max_code IS NULL THEN
    v_next := (v_prefix || '0000001')::BIGINT;
  ELSE
    v_next := v_max_code + 1;
  END IF;

  RETURN v_next::TEXT;
END;
$$;

-- Allow purchase roles to add sellers from sample conversion modal
ALTER TABLE pr_sellers ADD COLUMN IF NOT EXISTS name_cn TEXT DEFAULT '';

DROP POLICY IF EXISTS "pr_sellers write" ON pr_sellers;
CREATE POLICY "pr_sellers write"
  ON pr_sellers FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin-tr', 'admin', 'manager', 'store', 'account')
    )
  );

CREATE OR REPLACE FUNCTION rpc_create_pr_seller(
  p_name TEXT,
  p_name_cn TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_id UUID;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin-tr', 'admin', 'manager', 'store', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์เพิ่มผู้ขาย (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  IF COALESCE(trim(p_name), '') = '' THEN
    RAISE EXCEPTION 'กรุณาระบุชื่อผู้ขาย';
  END IF;

  INSERT INTO pr_sellers (name, name_cn, is_active)
  VALUES (trim(p_name), COALESCE(trim(p_name_cn), ''), true)
  ON CONFLICT (name) DO UPDATE
    SET name_cn = EXCLUDED.name_cn,
        is_active = true,
        updated_at = NOW()
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'id', v_id,
    'name', trim(p_name),
    'name_cn', COALESCE(trim(p_name_cn), '')
  );
END;
$$;

COMMIT;
