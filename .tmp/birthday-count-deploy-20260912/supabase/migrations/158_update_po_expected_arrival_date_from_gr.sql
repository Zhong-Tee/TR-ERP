-- ============================================
-- Allow editing PO expected arrival date from GR screen
-- ============================================

CREATE OR REPLACE FUNCTION rpc_update_po_expected_arrival_date(
  p_po_id UUID,
  p_expected_arrival_date DATE,
  p_user_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_uid UUID := COALESCE(auth.uid(), p_user_id);
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'admin-tr', 'manager', 'store', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ไขกำหนดเข้า PO (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM inv_po
    WHERE id = p_po_id
      AND status IN ('open', 'ordered', 'partial')
  ) THEN
    RAISE EXCEPTION 'PO ไม่อยู่ในสถานะที่แก้ไขกำหนดเข้าได้';
  END IF;

  UPDATE inv_po
  SET expected_arrival_date = p_expected_arrival_date,
      updated_at = NOW()
  WHERE id = p_po_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบ PO';
  END IF;
END;
$$;
