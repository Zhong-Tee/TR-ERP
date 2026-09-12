-- ============================================
-- 126: PR Lock Supplier (1 PR = 1 Supplier)
-- ============================================

-- 1. Add supplier columns to inv_pr
ALTER TABLE inv_pr ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES pr_sellers(id);
ALTER TABLE inv_pr ADD COLUMN IF NOT EXISTS supplier_name TEXT;

-- 2. Update rpc_create_pr to accept supplier
CREATE OR REPLACE FUNCTION rpc_create_pr(
  p_items JSONB,
  p_note TEXT DEFAULT NULL,
  p_user_id UUID DEFAULT NULL,
  p_pr_type TEXT DEFAULT 'normal',
  p_supplier_id UUID DEFAULT NULL,
  p_supplier_name TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pr_id UUID;
  v_pr_no TEXT;
  v_item JSONB;
  v_last_price NUMERIC(12,2);
  v_today TEXT;
  v_seq INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pr_no_gen'));

  v_today := to_char(NOW() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD');

  SELECT COALESCE(MAX(CAST(SPLIT_PART(pr_no, '-', 3) AS INTEGER)), 0) + 1
  INTO v_seq
  FROM inv_pr
  WHERE pr_no LIKE 'PR-' || v_today || '-___';

  v_pr_no := 'PR-' || v_today || '-' || lpad(v_seq::text, 3, '0');

  INSERT INTO inv_pr (pr_no, status, requested_by, requested_at, note, pr_type, supplier_id, supplier_name)
  VALUES (v_pr_no, 'pending', p_user_id, NOW(), p_note, COALESCE(p_pr_type, 'normal'), p_supplier_id, p_supplier_name)
  RETURNING id INTO v_pr_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT last_price INTO v_last_price
    FROM v_product_last_price
    WHERE product_id = (v_item->>'product_id')::UUID;

    INSERT INTO inv_pr_items (pr_id, product_id, qty, unit, estimated_price, last_purchase_price, note)
    VALUES (
      v_pr_id,
      (v_item->>'product_id')::UUID,
      (v_item->>'qty')::NUMERIC,
      v_item->>'unit',
      (v_item->>'estimated_price')::NUMERIC,
      COALESCE(v_last_price, NULL),
      v_item->>'note'
    );
  END LOOP;

  RETURN jsonb_build_object('id', v_pr_id, 'pr_no', v_pr_no);
END;
$$;
