-- 195: แก้ rpc_next_work_order_name ให้ seed จากเลขล่าสุดใน or_work_orders
-- กันกรณีเพิ่งเพิ่ม registry แล้วกลับไปเริ่ม R1

CREATE OR REPLACE FUNCTION rpc_next_work_order_name(
  p_prefix TEXT,
  p_date_part TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_prefix TEXT;
  v_date TEXT;
  v_next INT;
  v_seed INT;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'order_staff', 'packing_staff', 'manager', 'production') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์สร้างเลขใบงาน';
  END IF;

  v_prefix := trim(both FROM coalesce(p_prefix,''));
  v_date := trim(both FROM coalesce(p_date_part,''));
  IF v_prefix = '' OR v_date = '' THEN
    RAISE EXCEPTION 'ข้อมูลไม่ครบ (prefix/date_part)';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('wo_seq:' || v_prefix || ':' || v_date));

  -- seed: หา R ล่าสุดจาก or_work_orders (เฉพาะวัน+prefix เดียวกัน)
  SELECT COALESCE(MAX((regexp_match(work_order_name, ('^' || v_prefix || '-' || v_date || '-R([0-9]+)$')))[1]::int), 0)
  INTO v_seed
  FROM or_work_orders
  WHERE work_order_name ~ ('^' || v_prefix || '-' || v_date || '-R[0-9]+$');

  INSERT INTO or_work_order_sequences(prefix, date_part, last_r_no)
  VALUES (v_prefix, v_date, v_seed)
  ON CONFLICT (prefix, date_part) DO NOTHING;

  UPDATE or_work_order_sequences
  SET last_r_no = last_r_no + 1,
      updated_at = now()
  WHERE prefix = v_prefix AND date_part = v_date
  RETURNING last_r_no INTO v_next;

  RETURN v_prefix || '-' || v_date || '-R' || v_next::text;
END;
$$;

REVOKE ALL ON FUNCTION rpc_next_work_order_name(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_next_work_order_name(TEXT, TEXT) TO authenticated;

