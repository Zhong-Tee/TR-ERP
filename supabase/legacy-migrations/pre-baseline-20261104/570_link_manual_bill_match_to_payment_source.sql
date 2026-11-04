-- A manual bill match must also identify the underlying payment source when
-- possible. Unique candidates are linked automatically; ambiguous candidates
-- are returned to the UI for explicit selection.
BEGIN;

CREATE OR REPLACE FUNCTION public.bank_reconciliation_manual_source_candidates(
  p_transaction_id UUID,
  p_order_id UUID
)
RETURNS TABLE (
  source_type TEXT,
  source_id UUID,
  payment_at TIMESTAMPTZ,
  paid_amount NUMERIC,
  time_diff_minutes NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH tx AS (
    SELECT t.*, b.bank_code, b.account_number
    FROM public.ac_bank_statement_transactions t
    JOIN public.bank_settings b ON b.id = t.bank_setting_id
    WHERE t.id = p_transaction_id AND t.credit_amount > 0
  ), candidates AS (
    SELECT
      'verified_slip'::TEXT AS source_type,
      slip.id AS source_id,
      slip.easyslip_date AS payment_at,
      slip.verified_amount AS paid_amount,
      ABS(EXTRACT(EPOCH FROM (slip.easyslip_date - tx.transaction_at))) / 60.0 AS time_diff_minutes
    FROM tx
    JOIN public.ac_verified_slips slip
      ON slip.order_id = p_order_id
     AND COALESCE(slip.is_deleted, FALSE) = FALSE
     AND slip.easyslip_date IS NOT NULL
     AND slip.validation_status = 'passed'
     AND ABS(slip.verified_amount - tx.credit_amount) <= 0.01
     AND (
       (
         (NULLIF(trim(slip.easyslip_receiver_bank_id), '') IS NULL OR trim(slip.easyslip_receiver_bank_id) = tx.bank_code)
         AND (
           NULLIF(regexp_replace(COALESCE(slip.easyslip_receiver_account, ''), '\D', '', 'g'), '') IS NULL
           OR right(regexp_replace(slip.easyslip_receiver_account, '\D', '', 'g'), 4)
              = right(regexp_replace(tx.account_number, '\D', '', 'g'), 4)
         )
       )
       OR (
         trim(COALESCE(slip.expected_bank_code, '')) = tx.bank_code
         AND right(regexp_replace(COALESCE(slip.expected_bank_account, ''), '\D', '', 'g'), 4)
             = right(regexp_replace(tx.account_number, '\D', '', 'g'), 4)
       )
     )
    WHERE NOT EXISTS (
      SELECT 1 FROM public.ac_bank_reconciliation_allocations used
      WHERE used.verified_slip_id = slip.id
    )

    UNION ALL

    SELECT
      'manual_slip'::TEXT,
      manual.id,
      (manual.transfer_date || ' ' || manual.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok',
      manual.transfer_amount,
      ABS(EXTRACT(EPOCH FROM (
        ((manual.transfer_date || ' ' || manual.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok') - tx.transaction_at
      ))) / 60.0
    FROM tx
    JOIN public.ac_manual_slip_checks manual
      ON manual.order_id = p_order_id
     AND manual.status = 'approved'
     AND manual.transfer_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     AND manual.transfer_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     AND ABS(manual.transfer_amount - tx.credit_amount) <= 0.01
    JOIN public.or_orders o ON o.id = manual.order_id
    WHERE EXISTS (
      SELECT 1 FROM public.bank_settings_channels channel
      WHERE channel.bank_setting_id = tx.bank_setting_id
        AND channel.channel_code = o.channel_code
    )
      AND NOT EXISTS (
        SELECT 1 FROM public.ac_bank_reconciliation_allocations used
        WHERE used.manual_slip_check_id = manual.id
      )
  )
  SELECT
    candidate.source_type,
    candidate.source_id,
    candidate.payment_at,
    candidate.paid_amount,
    round(candidate.time_diff_minutes::NUMERIC, 1)
  FROM candidates candidate
  ORDER BY candidate.time_diff_minutes, candidate.source_type, candidate.source_id;
$$;

REVOKE ALL ON FUNCTION public.bank_reconciliation_manual_source_candidates(UUID, UUID)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.bank_reconciliation_set_manual_match_authorized_impl(
  p_transaction_id UUID,
  p_bill_no TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_tx public.ac_bank_statement_transactions;
  v_order public.or_orders;
  v_candidate_count INTEGER := 0;
  v_source_type TEXT;
  v_source_id UUID;
  v_candidates JSONB := '[]'::JSONB;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ผลกระทบยอด';
  END IF;

  SELECT * INTO v_tx
  FROM public.ac_bank_statement_transactions
  WHERE id = p_transaction_id
  FOR UPDATE;
  IF NOT FOUND OR v_tx.credit_amount <= 0 THEN RAISE EXCEPTION 'ไม่พบรายการเงินเข้า'; END IF;

  SELECT * INTO v_order
  FROM public.or_orders
  WHERE upper(trim(bill_no)) = upper(trim(p_bill_no)) AND status <> 'ยกเลิก'
  LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบบิล หรือบิลถูกยกเลิก'; END IF;

  SELECT
    COUNT(*)::INTEGER,
    COALESCE(jsonb_agg(to_jsonb(candidate) ORDER BY candidate.time_diff_minutes), '[]'::JSONB)
  INTO v_candidate_count, v_candidates
  FROM public.bank_reconciliation_manual_source_candidates(v_tx.id, v_order.id) candidate;

  IF v_candidate_count > 1 THEN
    RETURN jsonb_build_object(
      'matched', FALSE,
      'requires_source_selection', TRUE,
      'transaction_id', v_tx.id,
      'order_id', v_order.id,
      'bill_no', v_order.bill_no,
      'source_candidate_count', v_candidate_count,
      'candidates', v_candidates
    );
  END IF;

  IF v_candidate_count = 1 THEN
    SELECT candidate.source_type, candidate.source_id
    INTO v_source_type, v_source_id
    FROM public.bank_reconciliation_manual_source_candidates(v_tx.id, v_order.id)
      candidate
    LIMIT 1;
  END IF;

  DELETE FROM public.ac_bank_reconciliation_allocations WHERE transaction_id = v_tx.id;
  INSERT INTO public.ac_bank_reconciliation_allocations (
    transaction_id, order_id, verified_slip_id, manual_slip_check_id,
    allocated_amount, match_method, matched_by
  ) VALUES (
    v_tx.id,
    v_order.id,
    CASE WHEN v_source_type = 'verified_slip' THEN v_source_id ELSE NULL END,
    CASE WHEN v_source_type = 'manual_slip' THEN v_source_id ELSE NULL END,
    v_tx.credit_amount,
    CASE
      WHEN v_source_type = 'verified_slip' THEN 'manual_bill'
      WHEN v_source_type = 'manual_slip' THEN 'manual_bill'
      ELSE 'manual_bill'
    END,
    auth.uid()
  );
  UPDATE public.ac_bank_statement_transactions SET reconciliation_status = 'matched' WHERE id = v_tx.id;

  RETURN jsonb_build_object(
    'matched', TRUE,
    'requires_source_selection', FALSE,
    'transaction_id', v_tx.id,
    'order_id', v_order.id,
    'bill_no', v_order.bill_no,
    'source_candidate_count', v_candidate_count,
    'source_linked', v_candidate_count = 1,
    'source_type', v_source_type,
    'source_id', v_source_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.bank_reconciliation_set_manual_match_source(
  p_transaction_id UUID,
  p_bill_no TEXT,
  p_source_type TEXT,
  p_source_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tx public.ac_bank_statement_transactions;
  v_order public.or_orders;
  v_candidate RECORD;
BEGIN
  PERFORM public.bank_reconciliation_require_authorized_role();
  IF p_source_type NOT IN ('verified_slip', 'manual_slip') THEN
    RAISE EXCEPTION 'ประเภทแหล่งข้อมูลไม่ถูกต้อง';
  END IF;

  SELECT * INTO v_tx
  FROM public.ac_bank_statement_transactions
  WHERE id = p_transaction_id
  FOR UPDATE;
  IF NOT FOUND OR v_tx.credit_amount <= 0 THEN RAISE EXCEPTION 'ไม่พบรายการเงินเข้า'; END IF;

  SELECT * INTO v_order
  FROM public.or_orders
  WHERE upper(trim(bill_no)) = upper(trim(p_bill_no)) AND status <> 'ยกเลิก'
  LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบบิล หรือบิลถูกยกเลิก'; END IF;

  SELECT * INTO v_candidate
  FROM public.bank_reconciliation_manual_source_candidates(v_tx.id, v_order.id) candidate
  WHERE candidate.source_type = p_source_type AND candidate.source_id = p_source_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'สลิปที่เลือกไม่พร้อมใช้งาน หรือถูกจับคู่ไปแล้ว';
  END IF;

  DELETE FROM public.ac_bank_reconciliation_allocations WHERE transaction_id = v_tx.id;
  INSERT INTO public.ac_bank_reconciliation_allocations (
    transaction_id, order_id, verified_slip_id, manual_slip_check_id,
    allocated_amount, match_method, matched_by
  ) VALUES (
    v_tx.id,
    v_order.id,
    CASE WHEN p_source_type = 'verified_slip' THEN p_source_id ELSE NULL END,
    CASE WHEN p_source_type = 'manual_slip' THEN p_source_id ELSE NULL END,
    v_tx.credit_amount,
    'manual_bill',
    auth.uid()
  );
  UPDATE public.ac_bank_statement_transactions SET reconciliation_status = 'matched' WHERE id = v_tx.id;

  RETURN jsonb_build_object(
    'matched', TRUE,
    'transaction_id', v_tx.id,
    'order_id', v_order.id,
    'bill_no', v_order.bill_no,
    'source_linked', TRUE,
    'source_type', p_source_type,
    'source_id', p_source_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bank_reconciliation_set_manual_match_source(UUID, TEXT, TEXT, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_set_manual_match_source(UUID, TEXT, TEXT, UUID)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.bank_repair_unique_manual_bill_sources()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_allocation RECORD;
  v_candidate RECORD;
  v_count INTEGER;
  v_updated INTEGER := 0;
BEGIN
  FOR v_allocation IN
    SELECT allocation.id, allocation.transaction_id, allocation.order_id
    FROM public.ac_bank_reconciliation_allocations allocation
    WHERE allocation.verified_slip_id IS NULL
      AND allocation.manual_slip_check_id IS NULL
      AND allocation.match_method = 'manual_bill'
    ORDER BY allocation.matched_at, allocation.id
  LOOP
    SELECT COUNT(*)::INTEGER INTO v_count
    FROM public.bank_reconciliation_manual_source_candidates(
      v_allocation.transaction_id,
      v_allocation.order_id
    );

    IF v_count = 1 THEN
      SELECT * INTO v_candidate
      FROM public.bank_reconciliation_manual_source_candidates(
        v_allocation.transaction_id,
        v_allocation.order_id
      )
      LIMIT 1;

      UPDATE public.ac_bank_reconciliation_allocations
      SET verified_slip_id = CASE WHEN v_candidate.source_type = 'verified_slip' THEN v_candidate.source_id ELSE NULL END,
          manual_slip_check_id = CASE WHEN v_candidate.source_type = 'manual_slip' THEN v_candidate.source_id ELSE NULL END,
          note = concat_ws(' | ', NULLIF(note, ''), 'เชื่อมแหล่งชำระอัตโนมัติจากการจับคู่เลขบิลเดิม')
      WHERE id = v_allocation.id
        AND verified_slip_id IS NULL
        AND manual_slip_check_id IS NULL;
      IF FOUND THEN v_updated := v_updated + 1; END IF;
    END IF;
  END LOOP;

  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.bank_repair_unique_manual_bill_sources()
  FROM PUBLIC, anon, authenticated;

SELECT public.bank_repair_unique_manual_bill_sources();

NOTIFY pgrst, 'reload schema';
COMMIT;
