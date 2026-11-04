-- Repair the missing-payment RPC for databases that already applied migration 561.
-- PL/pgSQL output variables have the same names as the UNION result columns, so
-- an unqualified ORDER BY can raise an ambiguous-column error at runtime.
BEGIN;

CREATE OR REPLACE FUNCTION public.bank_reconciliation_missing_payments(p_import_id UUID)
RETURNS TABLE(
  source_type TEXT,
  source_id UUID,
  order_id UUID,
  bill_no TEXT,
  payment_at TIMESTAMPTZ,
  paid_amount NUMERIC,
  bill_amount NUMERIC,
  difference NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดูกระทบยอดธนาคาร';
  END IF;

  RETURN QUERY
  WITH selected_import AS (
    SELECT i.*, b.bank_code, b.account_number
    FROM public.ac_bank_statement_imports i
    JOIN public.bank_settings b ON b.id = i.bank_setting_id
    WHERE i.id = p_import_id
  ), missing AS (
    SELECT
      'verified_slip'::TEXT AS source_type,
      s.id AS source_id,
      s.order_id,
      o.bill_no,
      s.easyslip_date AS payment_at,
      s.verified_amount AS paid_amount,
      o.total_amount AS bill_amount,
      s.verified_amount - o.total_amount AS difference
    FROM selected_import i
    JOIN public.ac_verified_slips s
      ON s.easyslip_date >= i.period_start::TIMESTAMP AT TIME ZONE 'Asia/Bangkok'
     AND s.easyslip_date < (i.period_end + 1)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok'
    JOIN public.or_orders o ON o.id = s.order_id
    WHERE COALESCE(s.is_deleted, false) = false
      AND COALESCE(o.status, '') NOT IN ('รอลงข้อมูล', 'ลงข้อมูลผิด', 'ตรวจสอบไม่ผ่าน', 'ตรวจสอบไม่สำเร็จ', 'ยกเลิก')
      AND (NULLIF(trim(s.easyslip_receiver_bank_id), '') IS NULL OR trim(s.easyslip_receiver_bank_id) = i.bank_code)
      AND (
        NULLIF(regexp_replace(COALESCE(s.easyslip_receiver_account, ''), '\D', '', 'g'), '') IS NULL
        OR right(regexp_replace(s.easyslip_receiver_account, '\D', '', 'g'), 4)
           = right(regexp_replace(i.account_number, '\D', '', 'g'), 4)
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.ac_bank_reconciliation_allocations a WHERE a.verified_slip_id = s.id
      )
    UNION ALL
    SELECT
      'manual_slip'::TEXT AS source_type,
      m.id AS source_id,
      m.order_id,
      o.bill_no,
      (m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok' AS payment_at,
      m.transfer_amount AS paid_amount,
      o.total_amount AS bill_amount,
      m.transfer_amount - o.total_amount AS difference
    FROM selected_import i
    JOIN public.ac_manual_slip_checks m
      ON CASE
           WHEN m.transfer_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN m.transfer_date::DATE
           ELSE NULL
         END BETWEEN i.period_start AND i.period_end
    JOIN public.or_orders o ON o.id = m.order_id
    WHERE m.status = 'approved'
      AND m.transfer_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND COALESCE(o.status, '') <> 'ยกเลิก'
      AND EXISTS (
        SELECT 1 FROM public.bank_settings_channels bsc
        WHERE bsc.bank_setting_id = i.bank_setting_id AND bsc.channel_code = o.channel_code
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.ac_bank_reconciliation_allocations a WHERE a.manual_slip_check_id = m.id
      )
  )
  SELECT
    missing.source_type,
    missing.source_id,
    missing.order_id,
    missing.bill_no,
    missing.payment_at,
    missing.paid_amount,
    missing.bill_amount,
    missing.difference
  FROM missing
  ORDER BY missing.payment_at, missing.bill_no;
END;
$$;

REVOKE ALL ON FUNCTION public.bank_reconciliation_missing_payments(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_missing_payments(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
