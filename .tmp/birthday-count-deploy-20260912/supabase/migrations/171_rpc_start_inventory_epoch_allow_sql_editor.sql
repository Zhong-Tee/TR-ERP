-- 171: Allow rpc_start_inventory_epoch when auth.uid() is NULL (SQL Editor / scripts)
-- PIN 1688 is always required. When a JWT user exists, role must be superadmin/admin/account.

CREATE OR REPLACE FUNCTION rpc_start_inventory_epoch(
  p_pin TEXT,
  p_epoch_name TEXT DEFAULT NULL,
  p_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_uid UUID := auth.uid();
  v_epoch_id BIGINT;
  v_epoch_name TEXT;
  v_rows INT := 0;
  v_opening_value NUMERIC := 0;
BEGIN
  IF COALESCE(p_pin, '') <> '1688' THEN
    RAISE EXCEPTION 'รหัสยืนยันไม่ถูกต้อง';
  END IF;

  IF v_uid IS NOT NULL THEN
    SELECT role INTO v_role FROM us_users WHERE id = v_uid;
    IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'account') THEN
      RAISE EXCEPTION 'ไม่มีสิทธิ์เริ่มรอบบัญชีสต๊อกใหม่';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('inventory_epoch_start'));

  UPDATE ac_inventory_epochs
  SET is_active = FALSE
  WHERE is_active = TRUE;

  v_epoch_name := COALESCE(
    NULLIF(trim(COALESCE(p_epoch_name, '')), ''),
    'EPOCH-' || to_char(NOW() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD-HH24MI')
  );

  INSERT INTO ac_inventory_epochs (
    epoch_name, started_at, is_active, note, created_by
  )
  VALUES (
    v_epoch_name, NOW(), TRUE, p_note, v_uid
  )
  RETURNING id INTO v_epoch_id;

  INSERT INTO ac_inventory_epoch_openings (
    epoch_id, product_id, opening_qty, opening_value, opening_safety_qty, opening_safety_value
  )
  SELECT
    v_epoch_id,
    l.product_id,
    ROUND(SUM(CASE WHEN COALESCE(l.is_safety_stock, FALSE) = FALSE THEN l.qty_remaining ELSE 0 END), 2) AS opening_qty,
    ROUND(SUM(CASE WHEN COALESCE(l.is_safety_stock, FALSE) = FALSE THEN l.qty_remaining * l.unit_cost ELSE 0 END), 2) AS opening_value,
    ROUND(SUM(CASE WHEN COALESCE(l.is_safety_stock, FALSE) = TRUE  THEN l.qty_remaining ELSE 0 END), 2) AS opening_safety_qty,
    ROUND(SUM(CASE WHEN COALESCE(l.is_safety_stock, FALSE) = TRUE  THEN l.qty_remaining * l.unit_cost ELSE 0 END), 2) AS opening_safety_value
  FROM inv_stock_lots l
  WHERE l.qty_remaining > 0
  GROUP BY l.product_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT COALESCE(SUM(opening_value), 0)
  INTO v_opening_value
  FROM ac_inventory_epoch_openings
  WHERE epoch_id = v_epoch_id;

  RETURN jsonb_build_object(
    'success', true,
    'epoch_id', v_epoch_id,
    'epoch_name', v_epoch_name,
    'snapshot_products', v_rows,
    'opening_inventory_value', ROUND(v_opening_value, 2),
    'created_by', v_uid
  );
END;
$$;

COMMENT ON FUNCTION rpc_start_inventory_epoch(TEXT, TEXT, TEXT) IS
  'เริ่มรอบบัญชีสต๊อก: PIN 1688 บังคับเสมอ. ถ้ามี auth.uid() ต้องเป็น superadmin/admin/account. ถ้าไม่มี uid (เช่น SQL Editor) ใช้ได้เมื่อ PIN ถูก — created_by อาจเป็น NULL';

REVOKE ALL ON FUNCTION rpc_start_inventory_epoch(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_start_inventory_epoch(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION rpc_start_inventory_epoch(TEXT, TEXT, TEXT) TO service_role;
