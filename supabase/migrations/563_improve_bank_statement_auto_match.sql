-- Improve reconciliation for real bank data:
-- - bank posting time may differ from EasySlip by a few minutes
-- - use the sender account suffix from the statement to resolve repeated amounts
-- - multiple statement transactions may allocate to the same order (split payment)
BEGIN;

ALTER TABLE public.ac_bank_reconciliation_allocations
  DROP CONSTRAINT IF EXISTS ac_bank_reconciliation_allocations_match_method_check;
ALTER TABLE public.ac_bank_reconciliation_allocations
  ADD CONSTRAINT ac_bank_reconciliation_allocations_match_method_check
  CHECK (match_method IN (
    'exact_verified_slip',
    'exact_manual_slip',
    'time_tolerant_verified_slip',
    'time_tolerant_manual_slip',
    'sender_confirmed_verified_slip',
    'manual_bill'
  ));

CREATE OR REPLACE FUNCTION public.bank_statement_auto_match(p_import_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_tx RECORD;
  v_candidate_count INTEGER;
  v_exact_count INTEGER;
  v_sender_count INTEGER;
  v_source_kind TEXT;
  v_source_id UUID;
  v_order_id UUID;
  v_is_exact BOOLEAN;
  v_sender_match BOOLEAN;
  v_matched INTEGER := 0;
  v_ambiguous INTEGER := 0;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์กระทบยอดธนาคาร';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ac_bank_statement_imports WHERE id = p_import_id) THEN
    RAISE EXCEPTION 'ไม่พบรอบ Statement';
  END IF;

  FOR v_tx IN
    SELECT
      t.*,
      b.bank_code,
      b.account_number,
      substring(COALESCE(t.description, '') FROM 'X([0-9]{3,})') AS statement_sender_suffix
    FROM public.ac_bank_statement_transactions t
    JOIN public.bank_settings b ON b.id = t.bank_setting_id
    WHERE t.import_id = p_import_id
      AND t.credit_amount > 0
      AND t.reconciliation_status <> 'ignored'
      AND NOT EXISTS (
        SELECT 1 FROM public.ac_bank_reconciliation_allocations a WHERE a.transaction_id = t.id
      )
    ORDER BY t.transaction_at, t.id
  LOOP
    WITH candidates AS (
      SELECT
        'verified'::TEXT AS source_kind,
        s.id AS source_id,
        s.order_id,
        ABS(EXTRACT(EPOCH FROM (s.easyslip_date - v_tx.transaction_at))) AS time_diff_seconds,
        date_trunc('minute', s.easyslip_date) = date_trunc('minute', v_tx.transaction_at) AS is_exact,
        CASE
          WHEN NULLIF(v_tx.statement_sender_suffix, '') IS NULL THEN FALSE
          ELSE right(
            regexp_replace(
              COALESCE(
                s.easyslip_response #>> '{data,sender,account,bank,account}',
                s.easyslip_response #>> '{data,from,account,bank,account}',
                s.easyslip_response #>> '{data,from,account,account}',
                ''
              ),
              '\D', '', 'g'
            ),
            length(v_tx.statement_sender_suffix)
          ) = v_tx.statement_sender_suffix
        END AS sender_match
      FROM public.ac_verified_slips s
      JOIN public.or_orders o ON o.id = s.order_id
      WHERE COALESCE(s.is_deleted, false) = false
        AND COALESCE(o.status, '') NOT IN ('รอลงข้อมูล', 'ลงข้อมูลผิด', 'ตรวจสอบไม่ผ่าน', 'ตรวจสอบไม่สำเร็จ', 'ยกเลิก')
        AND s.easyslip_date >= v_tx.transaction_at - INTERVAL '10 minutes'
        AND s.easyslip_date <= v_tx.transaction_at + INTERVAL '10 minutes'
        AND ABS(s.verified_amount - v_tx.credit_amount) <= 0.01
        AND (
          (
            (NULLIF(trim(s.easyslip_receiver_bank_id), '') IS NULL OR trim(s.easyslip_receiver_bank_id) = v_tx.bank_code)
            AND (
              NULLIF(regexp_replace(COALESCE(s.easyslip_receiver_account, ''), '\D', '', 'g'), '') IS NULL
              OR right(regexp_replace(s.easyslip_receiver_account, '\D', '', 'g'), 4)
                 = right(regexp_replace(v_tx.account_number, '\D', '', 'g'), 4)
            )
          )
          OR (
            trim(COALESCE(s.expected_bank_code, '')) = v_tx.bank_code
            AND right(regexp_replace(COALESCE(s.expected_bank_account, ''), '\D', '', 'g'), 4)
                = right(regexp_replace(v_tx.account_number, '\D', '', 'g'), 4)
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.ac_bank_reconciliation_allocations used
          WHERE used.verified_slip_id = s.id
        )
      UNION ALL
      SELECT
        'manual'::TEXT AS source_kind,
        m.id AS source_id,
        m.order_id,
        ABS(EXTRACT(EPOCH FROM (
          ((m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok') - v_tx.transaction_at
        ))) AS time_diff_seconds,
        date_trunc('minute', (m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
          = date_trunc('minute', v_tx.transaction_at) AS is_exact,
        FALSE AS sender_match
      FROM public.ac_manual_slip_checks m
      JOIN public.or_orders o ON o.id = m.order_id
      WHERE m.status = 'approved'
        AND m.transfer_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND m.transfer_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND COALESCE(o.status, '') <> 'ยกเลิก'
        AND (m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok'
              >= v_tx.transaction_at - INTERVAL '10 minutes'
        AND (m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok'
              <= v_tx.transaction_at + INTERVAL '10 minutes'
        AND ABS(m.transfer_amount - v_tx.credit_amount) <= 0.01
        AND EXISTS (
          SELECT 1 FROM public.bank_settings_channels bsc
          WHERE bsc.bank_setting_id = v_tx.bank_setting_id
            AND bsc.channel_code = o.channel_code
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.ac_bank_reconciliation_allocations used
          WHERE used.manual_slip_check_id = m.id
        )
    ), stats AS (
      SELECT
        COUNT(*)::INTEGER AS candidate_count,
        COUNT(*) FILTER (WHERE is_exact)::INTEGER AS exact_count,
        COUNT(*) FILTER (WHERE sender_match)::INTEGER AS sender_count
      FROM candidates
    ), selected AS (
      SELECT c.*
      FROM candidates c
      CROSS JOIN stats s
      WHERE (s.exact_count = 1 AND c.is_exact)
         OR (s.exact_count <> 1 AND s.sender_count = 1 AND c.sender_match)
         OR (s.exact_count = 0 AND s.sender_count <> 1 AND s.candidate_count = 1)
      ORDER BY
        CASE WHEN c.is_exact THEN 0 WHEN c.sender_match THEN 1 ELSE 2 END,
        c.time_diff_seconds,
        c.source_kind,
        c.source_id
      LIMIT 1
    )
    SELECT
      stats.candidate_count,
      stats.exact_count,
      stats.sender_count,
      selected.source_kind,
      selected.source_id,
      selected.order_id,
      selected.is_exact,
      selected.sender_match
    INTO
      v_candidate_count,
      v_exact_count,
      v_sender_count,
      v_source_kind,
      v_source_id,
      v_order_id,
      v_is_exact,
      v_sender_match
    FROM stats
    LEFT JOIN selected ON TRUE;

    IF v_source_id IS NOT NULL THEN
      INSERT INTO public.ac_bank_reconciliation_allocations (
        transaction_id, order_id, verified_slip_id, manual_slip_check_id,
        allocated_amount, match_method, matched_by
      ) VALUES (
        v_tx.id,
        v_order_id,
        CASE WHEN v_source_kind = 'verified' THEN v_source_id ELSE NULL END,
        CASE WHEN v_source_kind = 'manual' THEN v_source_id ELSE NULL END,
        v_tx.credit_amount,
        CASE
          WHEN v_source_kind = 'verified' AND v_is_exact THEN 'exact_verified_slip'
          WHEN v_source_kind = 'manual' AND v_is_exact THEN 'exact_manual_slip'
          WHEN v_source_kind = 'verified' AND v_sender_match THEN 'sender_confirmed_verified_slip'
          WHEN v_source_kind = 'verified' THEN 'time_tolerant_verified_slip'
          ELSE 'time_tolerant_manual_slip'
        END,
        auth.uid()
      ) ON CONFLICT DO NOTHING;
      UPDATE public.ac_bank_statement_transactions
      SET reconciliation_status = 'matched'
      WHERE id = v_tx.id;
      v_matched := v_matched + 1;
    ELSIF v_candidate_count > 1 THEN
      UPDATE public.ac_bank_statement_transactions
      SET reconciliation_status = 'ambiguous'
      WHERE id = v_tx.id;
      v_ambiguous := v_ambiguous + 1;
    ELSE
      UPDATE public.ac_bank_statement_transactions
      SET reconciliation_status = 'unmatched'
      WHERE id = v_tx.id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'matched', v_matched,
    'ambiguous', v_ambiguous,
    'time_tolerance_minutes', 10,
    'supports_split_payment', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bank_statement_auto_match(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_statement_auto_match(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
