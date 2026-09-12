-- ============================================
-- PR roles + estimated price logic update
-- - จำกัดสิทธิ์ PR เป็น: superadmin, admin, store, account
-- - estimated_price ใช้ต้นทุนเฉลี่ยสินค้า (landed_cost) จากหน้า คลัง
-- - note ของ PR ไม่บังคับ (update ให้รับค่า null ได้)
-- ============================================

-- rpc_create_pr: role + estimated_price from landed_cost
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
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_uid UUID := COALESCE(auth.uid(), p_user_id);
  v_pr_id UUID;
  v_pr_no TEXT;
  v_item JSONB;
  v_estimated_cost NUMERIC(12,2);
  v_today TEXT;
  v_seq INT;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'store', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์สร้าง PR (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('pr_no_gen'));

  v_today := to_char(NOW() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD');

  SELECT COALESCE(MAX(CAST(SPLIT_PART(pr_no, '-', 3) AS INTEGER)), 0) + 1
  INTO v_seq
  FROM inv_pr
  WHERE pr_no LIKE 'PR-' || v_today || '-___';

  v_pr_no := 'PR-' || v_today || '-' || lpad(v_seq::text, 3, '0');

  INSERT INTO inv_pr (pr_no, status, requested_by, requested_at, note, pr_type, supplier_id, supplier_name)
  VALUES (v_pr_no, 'pending', v_uid, NOW(), p_note, COALESCE(p_pr_type, 'normal'), p_supplier_id, p_supplier_name)
  RETURNING id INTO v_pr_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT landed_cost INTO v_estimated_cost
    FROM pr_products
    WHERE id = (v_item->>'product_id')::UUID;

    INSERT INTO inv_pr_items (pr_id, product_id, qty, unit, estimated_price, last_purchase_price, note)
    VALUES (
      v_pr_id,
      (v_item->>'product_id')::UUID,
      (v_item->>'qty')::NUMERIC,
      v_item->>'unit',
      v_estimated_cost,
      NULL,
      v_item->>'note'
    );
  END LOOP;

  RETURN jsonb_build_object('id', v_pr_id, 'pr_no', v_pr_no);
END;
$$;

-- rpc_update_pr: role + estimated_price from landed_cost + note nullable
CREATE OR REPLACE FUNCTION rpc_update_pr(
  p_pr_id UUID,
  p_items JSONB,
  p_note TEXT DEFAULT NULL,
  p_pr_type TEXT DEFAULT NULL,
  p_supplier_id UUID DEFAULT NULL,
  p_supplier_name TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_item JSONB;
  v_estimated_cost NUMERIC(12,2);
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'store', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไข PR (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM inv_pr WHERE id = p_pr_id AND status = 'pending') THEN
    RAISE EXCEPTION 'PR ไม่อยู่ในสถานะรออนุมัติ ไม่สามารถแก้ไขได้';
  END IF;

  UPDATE inv_pr
  SET note = p_note,
      pr_type = COALESCE(p_pr_type, pr_type),
      supplier_id = p_supplier_id,
      supplier_name = p_supplier_name,
      updated_at = NOW()
  WHERE id = p_pr_id;

  DELETE FROM inv_pr_items WHERE pr_id = p_pr_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT landed_cost INTO v_estimated_cost
    FROM pr_products
    WHERE id = (v_item->>'product_id')::UUID;

    INSERT INTO inv_pr_items (pr_id, product_id, qty, unit, estimated_price, last_purchase_price, note)
    VALUES (
      p_pr_id,
      (v_item->>'product_id')::UUID,
      (v_item->>'qty')::NUMERIC,
      v_item->>'unit',
      v_estimated_cost,
      NULL,
      v_item->>'note'
    );
  END LOOP;
END;
$$;

-- rpc_approve_pr: role set
CREATE OR REPLACE FUNCTION rpc_approve_pr(p_pr_id UUID, p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_uid  UUID := auth.uid();
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'store', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติ PR (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  UPDATE inv_pr
  SET status = 'approved', approved_by = v_uid, approved_at = NOW()
  WHERE id = p_pr_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'PR ไม่อยู่ในสถานะรออนุมัติ'; END IF;
END;
$$;

-- rpc_reject_pr: role set
CREATE OR REPLACE FUNCTION rpc_reject_pr(p_pr_id UUID, p_user_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_uid  UUID := auth.uid();
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'store', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ปฏิเสธ PR (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  UPDATE inv_pr
  SET status = 'rejected', rejected_by = v_uid, rejected_at = NOW(), rejection_reason = p_reason
  WHERE id = p_pr_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'PR ไม่อยู่ในสถานะรออนุมัติ'; END IF;
END;
$$;
