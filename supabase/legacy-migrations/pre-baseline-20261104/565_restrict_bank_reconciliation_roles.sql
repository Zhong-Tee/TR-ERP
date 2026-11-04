-- Restrict bank reconciliation data and RPCs to account and superadmin only.
-- UI checks are duplicated at the database boundary so direct RPC/table calls
-- cannot be used by another application role.
BEGIN;

DROP POLICY IF EXISTS ac_bank_statement_imports_account_access ON public.ac_bank_statement_imports;
CREATE POLICY ac_bank_statement_imports_account_access
  ON public.ac_bank_statement_imports FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'account')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'account')
  ));

DROP POLICY IF EXISTS ac_bank_statement_transactions_account_access ON public.ac_bank_statement_transactions;
CREATE POLICY ac_bank_statement_transactions_account_access
  ON public.ac_bank_statement_transactions FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'account')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'account')
  ));

DROP POLICY IF EXISTS ac_bank_reconciliation_allocations_account_access ON public.ac_bank_reconciliation_allocations;
CREATE POLICY ac_bank_reconciliation_allocations_account_access
  ON public.ac_bank_reconciliation_allocations FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'account')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'account')
  ));

-- Preserve the implementation created by migrations 561-564, then expose
-- role-checking wrappers under the original API names.
ALTER FUNCTION public.bank_statement_auto_match(UUID)
  RENAME TO bank_statement_auto_match_authorized_impl;
ALTER FUNCTION public.bank_statement_import(UUID, TEXT, TEXT, JSONB, JSONB)
  RENAME TO bank_statement_import_authorized_impl;
ALTER FUNCTION public.bank_reconciliation_set_manual_match(UUID, TEXT)
  RENAME TO bank_reconciliation_set_manual_match_authorized_impl;
ALTER FUNCTION public.bank_reconciliation_clear_match(UUID)
  RENAME TO bank_reconciliation_clear_match_authorized_impl;
ALTER FUNCTION public.bank_reconciliation_missing_payments(UUID)
  RENAME TO bank_reconciliation_missing_payments_authorized_impl;
ALTER FUNCTION public.bank_statement_match_diagnostics(UUID)
  RENAME TO bank_statement_match_diagnostics_authorized_impl;

REVOKE ALL ON FUNCTION public.bank_statement_auto_match_authorized_impl(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bank_statement_import_authorized_impl(UUID, TEXT, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bank_reconciliation_set_manual_match_authorized_impl(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bank_reconciliation_clear_match_authorized_impl(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bank_reconciliation_missing_payments_authorized_impl(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bank_statement_match_diagnostics_authorized_impl(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.bank_reconciliation_require_authorized_role()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ใช้งานกระทบยอดธนาคาร';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.bank_reconciliation_require_authorized_role() FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.bank_statement_auto_match(p_import_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.bank_reconciliation_require_authorized_role();
  RETURN public.bank_statement_auto_match_authorized_impl(p_import_id);
END;
$$;

CREATE FUNCTION public.bank_statement_import(
  p_bank_setting_id UUID,
  p_file_name TEXT,
  p_file_hash TEXT,
  p_metadata JSONB,
  p_transactions JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.bank_reconciliation_require_authorized_role();
  RETURN public.bank_statement_import_authorized_impl(
    p_bank_setting_id, p_file_name, p_file_hash, p_metadata, p_transactions
  );
END;
$$;

CREATE FUNCTION public.bank_reconciliation_set_manual_match(p_transaction_id UUID, p_bill_no TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.bank_reconciliation_require_authorized_role();
  RETURN public.bank_reconciliation_set_manual_match_authorized_impl(p_transaction_id, p_bill_no);
END;
$$;

CREATE FUNCTION public.bank_reconciliation_clear_match(p_transaction_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.bank_reconciliation_require_authorized_role();
  PERFORM public.bank_reconciliation_clear_match_authorized_impl(p_transaction_id);
END;
$$;

CREATE FUNCTION public.bank_reconciliation_missing_payments(p_import_id UUID)
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
BEGIN
  PERFORM public.bank_reconciliation_require_authorized_role();
  RETURN QUERY SELECT * FROM public.bank_reconciliation_missing_payments_authorized_impl(p_import_id);
END;
$$;

CREATE FUNCTION public.bank_statement_match_diagnostics(p_import_id UUID)
RETURNS TABLE(
  transaction_id UUID,
  reason_code TEXT,
  candidate_count INTEGER,
  candidates JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.bank_reconciliation_require_authorized_role();
  RETURN QUERY SELECT * FROM public.bank_statement_match_diagnostics_authorized_impl(p_import_id);
END;
$$;

REVOKE ALL ON FUNCTION public.bank_statement_auto_match(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_statement_import(UUID, TEXT, TEXT, JSONB, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_reconciliation_set_manual_match(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_reconciliation_clear_match(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_reconciliation_missing_payments(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_statement_match_diagnostics(UUID) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.bank_statement_auto_match(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_statement_import(UUID, TEXT, TEXT, JSONB, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_set_manual_match(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_clear_match(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_missing_payments(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_statement_match_diagnostics(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
