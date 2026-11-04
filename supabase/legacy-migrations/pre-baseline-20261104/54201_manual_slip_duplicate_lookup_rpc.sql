BEGIN;

-- Support the manual-slip duplicate check without downloading the complete
-- verified-slip history (including the large EasySlip response) to the client.
CREATE INDEX IF NOT EXISTS idx_verified_slips_manual_duplicate_lookup
  ON public.ac_verified_slips (easyslip_date, verified_amount, order_id)
  WHERE COALESCE(is_deleted, false) = false AND easyslip_date IS NOT NULL;

CREATE OR REPLACE FUNCTION public.manual_slip_find_duplicates(
  p_order_id UUID,
  p_entries JSONB
)
RETURNS TABLE(
  entry_index INTEGER,
  duplicate_order_id UUID,
  duplicate_bill_no TEXT,
  easyslip_date TIMESTAMPTZ,
  verified_amount NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_valid_entry_count INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.us_users actor
    WHERE actor.id = auth.uid()
      AND actor.role IN ('superadmin', 'admin', 'account')
  ) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ตรวจสอบสลิปมือ';
  END IF;

  IF p_order_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.or_orders o WHERE o.id = p_order_id
  ) THEN
    RAISE EXCEPTION 'ไม่พบบิลที่ต้องการตรวจ';
  END IF;

  IF p_entries IS NULL
     OR jsonb_typeof(p_entries) <> 'array'
     OR jsonb_array_length(p_entries) < 1
     OR jsonb_array_length(p_entries) > 20
  THEN
    RAISE EXCEPTION 'ข้อมูลสลิปต้องมี 1 ถึง 20 รายการ';
  END IF;

  SELECT COUNT(*)
  INTO v_valid_entry_count
  FROM jsonb_to_recordset(p_entries) AS input(
    entry_index INTEGER,
    transfer_date TEXT,
    transfer_time TEXT,
    transfer_amount NUMERIC
  )
  WHERE input.entry_index IS NOT NULL
    AND BTRIM(input.transfer_date) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND BTRIM(input.transfer_time) ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND input.transfer_amount >= 0;

  IF v_valid_entry_count <> jsonb_array_length(p_entries) THEN
    RAISE EXCEPTION 'วันที่ เวลา หรือยอดโอนที่ใช้ตรวจสอบไม่ถูกต้อง';
  END IF;

  RETURN QUERY
  WITH raw_input AS (
    SELECT
      input.entry_index,
      BTRIM(input.transfer_date) AS transfer_date,
      BTRIM(input.transfer_time) AS transfer_time,
      input.transfer_amount
    FROM jsonb_to_recordset(p_entries) AS input(
      entry_index INTEGER,
      transfer_date TEXT,
      transfer_time TEXT,
      transfer_amount NUMERIC
    )
  ), normalized_input AS (
    SELECT
      input.entry_index,
      input.transfer_amount,
      (input.transfer_date || ' ' || input.transfer_time)::TIMESTAMP
        AT TIME ZONE 'Asia/Bangkok' AS transfer_minute
    FROM raw_input input
    WHERE input.entry_index IS NOT NULL
      AND input.transfer_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      AND input.transfer_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND input.transfer_amount >= 0
  )
  SELECT
    input.entry_index,
    slip.order_id AS duplicate_order_id,
    duplicate_order.bill_no AS duplicate_bill_no,
    slip.easyslip_date,
    slip.verified_amount
  FROM normalized_input input
  JOIN public.ac_verified_slips slip
    ON slip.easyslip_date >= input.transfer_minute
   AND slip.easyslip_date < input.transfer_minute + INTERVAL '1 minute'
   AND slip.verified_amount BETWEEN input.transfer_amount - 0.01 AND input.transfer_amount + 0.01
   AND slip.order_id <> p_order_id
   AND COALESCE(slip.is_deleted, false) = false
  JOIN public.or_orders duplicate_order ON duplicate_order.id = slip.order_id
  WHERE COALESCE(duplicate_order.status, '') NOT IN (
    'รอลงข้อมูล', 'ลงข้อมูลผิด', 'ตรวจสอบไม่ผ่าน', 'ตรวจสอบไม่สำเร็จ', 'ยกเลิก'
  )
  ORDER BY input.entry_index, slip.created_at DESC, slip.id;
END;
$$;

REVOKE ALL ON FUNCTION public.manual_slip_find_duplicates(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manual_slip_find_duplicates(UUID, JSONB) TO authenticated;

COMMENT ON FUNCTION public.manual_slip_find_duplicates(UUID, JSONB) IS
  'Finds used slips matching manual date, Bangkok minute and amount without returning full slip history or EasySlip payloads.';

NOTIFY pgrst, 'reload schema';

COMMIT;
