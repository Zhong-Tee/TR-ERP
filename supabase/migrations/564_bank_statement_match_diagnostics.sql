-- Explain why a bank credit was not matched without using the order creation date.
-- Candidate slips are searched by their actual transfer time within +/- 7 days so
-- staff can also review slips that were attached to an order later.
BEGIN;

CREATE OR REPLACE FUNCTION public.bank_statement_match_diagnostics(p_import_id UUID)
RETURNS TABLE (
  transaction_id UUID,
  reason_code TEXT,
  candidate_count INTEGER,
  candidates JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ตรวจสอบการกระทบยอดธนาคาร';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.ac_bank_statement_imports WHERE id = p_import_id) THEN
    RAISE EXCEPTION 'ไม่พบรอบ Statement';
  END IF;

  RETURN QUERY
  WITH tx AS (
    SELECT
      t.id,
      t.transaction_at,
      t.credit_amount,
      t.bank_setting_id,
      b.bank_code,
      b.account_number,
      substring(COALESCE(t.description, '') FROM 'X([0-9]{3,})') AS sender_suffix
    FROM public.ac_bank_statement_transactions t
    JOIN public.bank_settings b ON b.id = t.bank_setting_id
    WHERE t.import_id = p_import_id
      AND t.credit_amount > 0
      AND t.reconciliation_status IN ('unmatched', 'ambiguous')
      AND NOT EXISTS (
        SELECT 1 FROM public.ac_bank_reconciliation_allocations a
        WHERE a.transaction_id = t.id
      )
  ), candidate_base AS (
    SELECT
      t.id AS transaction_id,
      'verified_slip'::TEXT AS source_type,
      s.id AS source_id,
      s.order_id,
      o.bill_no,
      o.created_at AS bill_created_at,
      s.easyslip_date AS payment_at,
      s.verified_amount AS paid_amount,
      'approved'::TEXT AS source_status,
      (
        (
          (NULLIF(trim(s.easyslip_receiver_bank_id), '') IS NULL OR trim(s.easyslip_receiver_bank_id) = t.bank_code)
          AND (
            NULLIF(regexp_replace(COALESCE(s.easyslip_receiver_account, ''), '\D', '', 'g'), '') IS NULL
            OR right(regexp_replace(s.easyslip_receiver_account, '\D', '', 'g'), 4)
               = right(regexp_replace(t.account_number, '\D', '', 'g'), 4)
          )
        )
        OR (
          trim(COALESCE(s.expected_bank_code, '')) = t.bank_code
          AND right(regexp_replace(COALESCE(s.expected_bank_account, ''), '\D', '', 'g'), 4)
              = right(regexp_replace(t.account_number, '\D', '', 'g'), 4)
        )
      ) AS account_match,
      CASE
        WHEN NULLIF(t.sender_suffix, '') IS NULL THEN FALSE
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
          length(t.sender_suffix)
        ) = t.sender_suffix
      END AS sender_match,
      (used.id IS NOT NULL) AS already_allocated,
      ABS(EXTRACT(EPOCH FROM (s.easyslip_date - t.transaction_at))) / 60.0 AS time_diff_minutes,
      ABS(EXTRACT(EPOCH FROM (s.easyslip_date - t.transaction_at))) <= 600 AS within_auto_window,
      (COALESCE(s.is_deleted, FALSE) = FALSE AND COALESCE(o.status, '') <> 'ยกเลิก') AS usable
    FROM tx t
    JOIN public.ac_verified_slips s
      ON s.easyslip_date >= t.transaction_at - INTERVAL '7 days'
     AND s.easyslip_date <= t.transaction_at + INTERVAL '7 days'
     AND ABS(s.verified_amount - t.credit_amount) <= 0.01
    JOIN public.or_orders o ON o.id = s.order_id
    LEFT JOIN public.ac_bank_reconciliation_allocations used ON used.verified_slip_id = s.id

    UNION ALL

    SELECT
      t.id AS transaction_id,
      'manual_slip'::TEXT AS source_type,
      m.id AS source_id,
      m.order_id,
      o.bill_no,
      o.created_at AS bill_created_at,
      (m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok' AS payment_at,
      m.transfer_amount AS paid_amount,
      m.status AS source_status,
      EXISTS (
        SELECT 1 FROM public.bank_settings_channels bsc
        WHERE bsc.bank_setting_id = t.bank_setting_id
          AND bsc.channel_code = o.channel_code
      ) AS account_match,
      FALSE AS sender_match,
      (used.id IS NOT NULL) AS already_allocated,
      ABS(EXTRACT(EPOCH FROM (
        (m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok' - t.transaction_at
      ))) / 60.0 AS time_diff_minutes,
      ABS(EXTRACT(EPOCH FROM (
        (m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok' - t.transaction_at
      ))) <= 600 AS within_auto_window,
      (m.status = 'approved' AND COALESCE(o.status, '') <> 'ยกเลิก') AS usable
    FROM tx t
    JOIN public.ac_manual_slip_checks m
      ON m.transfer_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     AND m.transfer_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     AND (m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok'
          >= t.transaction_at - INTERVAL '7 days'
     AND (m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok'
          <= t.transaction_at + INTERVAL '7 days'
     AND ABS(m.transfer_amount - t.credit_amount) <= 0.01
    JOIN public.or_orders o ON o.id = m.order_id
    LEFT JOIN public.ac_bank_reconciliation_allocations used ON used.manual_slip_check_id = m.id
  ), ranked AS (
    SELECT
      c.*,
      row_number() OVER (
        PARTITION BY c.transaction_id
        ORDER BY
          CASE WHEN c.within_auto_window THEN 0 ELSE 1 END,
          CASE WHEN c.account_match THEN 0 ELSE 1 END,
          CASE WHEN c.sender_match THEN 0 ELSE 1 END,
          c.time_diff_minutes,
          c.source_id
      ) AS candidate_rank
    FROM candidate_base c
  ), stats AS (
    SELECT
      t.id AS transaction_id,
      COUNT(r.source_id)::INTEGER AS candidate_count,
      COUNT(r.source_id) FILTER (WHERE r.account_match)::INTEGER AS account_match_count,
      COUNT(r.source_id) FILTER (WHERE r.account_match AND r.usable)::INTEGER AS usable_count,
      COUNT(r.source_id) FILTER (WHERE r.account_match AND r.usable AND r.already_allocated)::INTEGER AS allocated_count,
      COUNT(r.source_id) FILTER (
        WHERE r.account_match AND r.usable AND NOT r.already_allocated AND r.within_auto_window
      )::INTEGER AS auto_candidate_count
    FROM tx t
    LEFT JOIN ranked r ON r.transaction_id = t.id
    GROUP BY t.id
  ), candidate_json AS (
    SELECT
      r.transaction_id,
      jsonb_agg(
        jsonb_build_object(
          'source_type', r.source_type,
          'source_id', r.source_id,
          'order_id', r.order_id,
          'bill_no', r.bill_no,
          'bill_created_at', r.bill_created_at,
          'payment_at', r.payment_at,
          'paid_amount', r.paid_amount,
          'source_status', r.source_status,
          'account_match', r.account_match,
          'sender_match', r.sender_match,
          'already_allocated', r.already_allocated,
          'within_auto_window', r.within_auto_window,
          'time_diff_minutes', round(r.time_diff_minutes::NUMERIC, 1),
          'payment_before_bill_hours', round((EXTRACT(EPOCH FROM (r.bill_created_at - r.payment_at)) / 3600.0)::NUMERIC, 1)
        ) ORDER BY r.candidate_rank
      ) FILTER (WHERE r.candidate_rank <= 5) AS candidates
    FROM ranked r
    GROUP BY r.transaction_id
  )
  SELECT
    s.transaction_id,
    CASE
      WHEN s.candidate_count = 0 THEN 'no_same_amount_slip'
      WHEN s.account_match_count = 0 THEN 'receiver_account_mismatch'
      WHEN s.usable_count = 0 THEN 'slip_not_ready'
      WHEN s.allocated_count = s.usable_count THEN 'slip_already_allocated'
      WHEN s.auto_candidate_count = 0 THEN 'outside_time_window'
      WHEN s.auto_candidate_count > 1 THEN 'multiple_candidates'
      ELSE 'rerun_auto_match'
    END AS reason_code,
    s.candidate_count,
    COALESCE(j.candidates, '[]'::JSONB) AS candidates
  FROM stats s
  LEFT JOIN candidate_json j ON j.transaction_id = s.transaction_id
  ORDER BY s.transaction_id;
END;
$$;

REVOKE ALL ON FUNCTION public.bank_statement_match_diagnostics(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_statement_match_diagnostics(UUID) TO authenticated;

COMMENT ON FUNCTION public.bank_statement_match_diagnostics(UUID) IS
  'Explains unmatched bank credits using slip transfer time, not order creation time.';

NOTIFY pgrst, 'reload schema';
COMMIT;
