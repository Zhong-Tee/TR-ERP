-- One operational summary across every imported Statement. Transaction rows
-- are already deduplicated by bank account and source fingerprint. Missing
-- slips are deduplicated again because overlapping import periods may expose
-- the same slip through more than one import.
BEGIN;

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
    COUNT(*) FILTER (
      WHERE tx.credit_amount > 0
        AND tx.reconciliation_status = 'unmatched'
    ),
    COUNT(*) FILTER (
      WHERE tx.credit_amount > 0
        AND tx.reconciliation_status = 'ambiguous'
    )
  INTO v_unmatched_count, v_ambiguous_count
  FROM public.ac_bank_statement_transactions tx;

  SELECT COUNT(*)
  INTO v_missing_payment_count
  FROM (
    SELECT DISTINCT missing.source_type, missing.source_id
    FROM public.ac_bank_statement_imports statement_import
    CROSS JOIN LATERAL public.bank_reconciliation_missing_payments(statement_import.id) missing
  ) unique_missing;

  RETURN jsonb_build_object(
    'unmatched_count', COALESCE(v_unmatched_count, 0),
    'ambiguous_count', COALESCE(v_ambiguous_count, 0),
    'missing_payment_count', COALESCE(v_missing_payment_count, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bank_reconciliation_global_summary()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_global_summary()
  TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
