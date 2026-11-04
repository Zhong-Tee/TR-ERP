-- 198: Allow reusing work order number when a work order is cancelled WITHOUT production start
-- Desired behavior:
-- - If a work order number was generated but later all bills were released and the job never started,
--   we should NOT "consume" that R number; next creation should reuse it (no skipping).
--
-- Implementation:
-- - Seed uses the maximum R among "non-reusable" work orders for (prefix,date):
--   - status <> 'ยกเลิก'  OR
--   - status = 'ยกเลิก' but has plan_jobs row with is_production_voided = true (started then voided)
-- - The sequence row is overwritten to that seed (may decrease) under advisory lock, then +1.

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

  -- seed: max R among non-reusable work orders only
  SELECT COALESCE(
    MAX((regexp_match(wo.work_order_name, ('^' || v_prefix || '-' || v_date || '-R([0-9]+)$')))[1]::int),
    0
  )
  INTO v_seed
  FROM or_work_orders wo
  LEFT JOIN plan_jobs pj ON pj.work_order_id = wo.id
  WHERE wo.work_order_name ~ ('^' || v_prefix || '-' || v_date || '-R[0-9]+$')
    AND (
      wo.status IS DISTINCT FROM 'ยกเลิก'
      OR coalesce(pj.is_production_voided, false) = true
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

