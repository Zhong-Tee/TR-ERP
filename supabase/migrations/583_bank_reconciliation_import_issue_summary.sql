-- Compact issue counts for the import picker. The client requests only the
-- currently loaded page of imports, keeping the screen responsive over time.
BEGIN;

CREATE OR REPLACE FUNCTION public.bank_reconciliation_import_issue_summary(p_import_ids UUID[])
RETURNS TABLE(
  import_id UUID,
  unmatched_count BIGINT,
  ambiguous_count BIGINT,
  missing_payment_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.bank_reconciliation_require_authorized_role();

  RETURN QUERY
  WITH transaction_counts AS (
    SELECT
      tx.import_id,
      COUNT(*) FILTER (
        WHERE tx.credit_amount > 0 AND tx.reconciliation_status = 'unmatched'
      ) AS unmatched_count,
      COUNT(*) FILTER (
        WHERE tx.credit_amount > 0 AND tx.reconciliation_status = 'ambiguous'
      ) AS ambiguous_count
    FROM public.ac_bank_statement_transactions tx
    WHERE tx.import_id = ANY(p_import_ids)
    GROUP BY tx.import_id
  )
  SELECT
    statement_import.id,
    COALESCE(transaction_counts.unmatched_count, 0),
    COALESCE(transaction_counts.ambiguous_count, 0),
    COALESCE(missing.missing_payment_count, 0)
  FROM public.ac_bank_statement_imports statement_import
  LEFT JOIN transaction_counts ON transaction_counts.import_id = statement_import.id
  LEFT JOIN LATERAL (
    SELECT COUNT(DISTINCT (payment.source_type, payment.source_id)) AS missing_payment_count
    FROM public.bank_reconciliation_missing_payments(statement_import.id) payment
  ) missing ON TRUE
  WHERE statement_import.id = ANY(p_import_ids)
  ORDER BY statement_import.uploaded_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.bank_reconciliation_import_issue_summary(UUID[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_import_issue_summary(UUID[])
  TO authenticated;

-- Replace the initial all-import implementation with a set-based calculation.
-- This scans each slip table once instead of invoking the per-import function
-- for every historical Statement.
CREATE OR REPLACE FUNCTION public.bank_reconciliation_global_summary()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_unmatched_count BIGINT;
  v_ambiguous_count BIGINT;
  v_missing_payment_count BIGINT;
BEGIN
  PERFORM public.bank_reconciliation_require_authorized_role();

  SELECT
    COUNT(*) FILTER (WHERE tx.credit_amount > 0 AND tx.reconciliation_status = 'unmatched'),
    COUNT(*) FILTER (WHERE tx.credit_amount > 0 AND tx.reconciliation_status = 'ambiguous')
  INTO v_unmatched_count, v_ambiguous_count
  FROM public.ac_bank_statement_transactions tx;

  SELECT COUNT(*)
  INTO v_missing_payment_count
  FROM (
    SELECT 'verified_slip'::TEXT AS source_type, slip.id AS source_id
    FROM public.ac_verified_slips slip
    JOIN public.or_orders customer_order ON customer_order.id = slip.order_id
    WHERE COALESCE(slip.is_deleted, false) = false
      AND slip.easyslip_date IS NOT NULL
      AND COALESCE(customer_order.status, '') NOT IN ('รอลงข้อมูล', 'ลงข้อมูลผิด', 'ตรวจสอบไม่ผ่าน', 'ตรวจสอบไม่สำเร็จ', 'ยกเลิก')
      AND NOT EXISTS (
        SELECT 1 FROM public.ac_bank_reconciliation_allocations allocation
        WHERE allocation.verified_slip_id = slip.id
      )
      AND EXISTS (
        SELECT 1
        FROM public.ac_bank_statement_imports statement_import
        JOIN public.bank_settings bank ON bank.id = statement_import.bank_setting_id
        WHERE slip.easyslip_date >= statement_import.period_start::TIMESTAMP AT TIME ZONE 'Asia/Bangkok'
          AND slip.easyslip_date < (statement_import.period_end + 1)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok'
          AND (NULLIF(trim(slip.easyslip_receiver_bank_id), '') IS NULL OR trim(slip.easyslip_receiver_bank_id) = bank.bank_code)
          AND (
            NULLIF(regexp_replace(COALESCE(slip.easyslip_receiver_account, ''), '\D', '', 'g'), '') IS NULL
            OR right(regexp_replace(slip.easyslip_receiver_account, '\D', '', 'g'), 4)
               = right(regexp_replace(bank.account_number, '\D', '', 'g'), 4)
          )
      )
    UNION ALL
    SELECT 'manual_slip'::TEXT AS source_type, manual_slip.id AS source_id
    FROM public.ac_manual_slip_checks manual_slip
    JOIN public.or_orders customer_order ON customer_order.id = manual_slip.order_id
    WHERE manual_slip.status = 'approved'
      AND manual_slip.transfer_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      AND manual_slip.transfer_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND COALESCE(customer_order.status, '') <> 'ยกเลิก'
      AND NOT EXISTS (
        SELECT 1 FROM public.ac_bank_reconciliation_allocations allocation
        WHERE allocation.manual_slip_check_id = manual_slip.id
      )
      AND EXISTS (
        SELECT 1
        FROM public.ac_bank_statement_imports statement_import
        JOIN public.bank_settings_channels channel
          ON channel.bank_setting_id = statement_import.bank_setting_id
         AND channel.channel_code = customer_order.channel_code
        WHERE CASE
          WHEN manual_slip.transfer_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN manual_slip.transfer_date::DATE
          ELSE NULL
        END BETWEEN statement_import.period_start AND statement_import.period_end
      )
  ) missing;

  RETURN jsonb_build_object(
    'unmatched_count', COALESCE(v_unmatched_count, 0),
    'ambiguous_count', COALESCE(v_ambiguous_count, 0),
    'missing_payment_count', COALESCE(v_missing_payment_count, 0)
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
