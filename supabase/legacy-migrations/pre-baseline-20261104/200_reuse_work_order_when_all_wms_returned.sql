-- 200: Reuse work order R when voided but all WMS lines returned/cancelled

CREATE OR REPLACE FUNCTION fn_work_order_wms_fully_returned_or_cleared(p_work_order_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_name TEXT;
BEGIN
  IF p_work_order_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT trim(both FROM coalesce(work_order_name, '')) INTO v_name
  FROM or_work_orders
  WHERE id = p_work_order_id;

  IF v_name = '' THEN
    RETURN false;
  END IF;

  RETURN NOT EXISTS (
    SELECT 1
    FROM wms_orders w
    WHERE (
      w.work_order_id = p_work_order_id
      OR (
        w.work_order_id IS NULL
        AND trim(both FROM coalesce(w.order_id, '')) = v_name
      )
    )
    AND w.status NOT IN ('returned', 'cancelled')
  );
END;
$$;

REVOKE ALL ON FUNCTION fn_work_order_wms_fully_returned_or_cleared(UUID) FROM PUBLIC;

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

  SELECT COALESCE(
    MAX((regexp_match(wo.work_order_name, ('^' || v_prefix || '-' || v_date || '-R([0-9]+)$')))[1]::int),
    0
  )
  INTO v_seed
  FROM or_work_orders wo
  WHERE wo.work_order_name ~ ('^' || v_prefix || '-' || v_date || '-R[0-9]+$')
    AND (
      wo.status IS DISTINCT FROM 'ยกเลิก'
      OR (
        EXISTS (
          SELECT 1 FROM plan_jobs pj
          WHERE pj.work_order_id = wo.id
            AND pj.is_production_voided = true
        )
        AND NOT fn_work_order_wms_fully_returned_or_cleared(wo.id)
      )
    );

  INSERT INTO or_work_order_sequences(prefix, date_part, last_r_no)
  VALUES (v_prefix, v_date, v_seed)
  ON CONFLICT (prefix, date_part)
  DO UPDATE SET
    last_r_no = EXCLUDED.last_r_no,
    updated_at = now();

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

COMMENT ON FUNCTION fn_work_order_wms_fully_returned_or_cleared(UUID) IS
  'true เมื่อไม่มีแถว wms_orders ที่ status ไม่ใช่ returned/cancelled - ใช้ตัดสิน reuse เลข R';
