-- Retry every unverified image of a manually approved bill through EasySlip.
-- Each image is recorded independently and matched to one manual transfer entry.
BEGIN;

ALTER TABLE public.ac_manual_slip_checks
  ADD COLUMN IF NOT EXISTS easyslip_retry_status TEXT,
  ADD COLUMN IF NOT EXISTS easyslip_retry_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS easyslip_retry_checked_by UUID REFERENCES public.us_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS easyslip_retry_error TEXT;

ALTER TABLE public.ac_manual_slip_checks
  DROP CONSTRAINT IF EXISTS ac_manual_slip_checks_easyslip_retry_status_check;
ALTER TABLE public.ac_manual_slip_checks
  ADD CONSTRAINT ac_manual_slip_checks_easyslip_retry_status_check
  CHECK (easyslip_retry_status IS NULL OR easyslip_retry_status IN ('passed', 'failed'));

ALTER TABLE public.ac_manual_slip_checks
  DROP CONSTRAINT IF EXISTS ac_manual_slip_checks_status_check;
ALTER TABLE public.ac_manual_slip_checks
  ADD CONSTRAINT ac_manual_slip_checks_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'verified_by_easyslip'));

CREATE TABLE IF NOT EXISTS public.ac_manual_slip_easyslip_retries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.or_orders(id) ON DELETE CASCADE,
  requested_manual_slip_id UUID NOT NULL REFERENCES public.ac_manual_slip_checks(id) ON DELETE CASCADE,
  matched_manual_slip_id UUID REFERENCES public.ac_manual_slip_checks(id) ON DELETE SET NULL,
  verified_slip_id UUID NOT NULL REFERENCES public.ac_verified_slips(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_by UUID REFERENCES public.us_users(id) ON DELETE SET NULL,
  error_message TEXT,
  UNIQUE (verified_slip_id),
  UNIQUE (matched_manual_slip_id)
);

ALTER TABLE public.ac_manual_slip_easyslip_retries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Account roles can read manual EasySlip retries" ON public.ac_manual_slip_easyslip_retries;
CREATE POLICY "Account roles can read manual EasySlip retries"
  ON public.ac_manual_slip_easyslip_retries FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.us_users u
      WHERE u.id = auth.uid() AND u.role IN ('superadmin', 'account')
    )
  );

CREATE OR REPLACE FUNCTION public.bank_manual_slip_retry_easyslip(
  p_manual_slip_id UUID,
  p_verified_slip_id UUID,
  p_bank_setting_id UUID,
  p_result JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_requested public.ac_manual_slip_checks;
  v_matched public.ac_manual_slip_checks;
  v_slip public.ac_verified_slips;
  v_bank public.bank_settings;
  v_response JSONB;
  v_api_success BOOLEAN := FALSE;
  v_pass BOOLEAN := FALSE;
  v_duplicate BOOLEAN := FALSE;
  v_amount NUMERIC;
  v_amount_text TEXT;
  v_trans_ref TEXT;
  v_date_text TEXT;
  v_payment_at TIMESTAMPTZ;
  v_receiver_bank TEXT;
  v_receiver_account TEXT;
  v_bank_match BOOLEAN := FALSE;
  v_account_match BOOLEAN := FALSE;
  v_error TEXT;
  v_errors TEXT[] := ARRAY[]::TEXT[];
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ตรวจ EasySlip ซ้ำ';
  END IF;

  SELECT * INTO v_requested
  FROM public.ac_manual_slip_checks
  WHERE id = p_manual_slip_id
  FOR UPDATE;
  IF NOT FOUND OR v_requested.status NOT IN ('approved', 'verified_by_easyslip') THEN
    RAISE EXCEPTION 'รายการนี้ไม่ใช่สลิปตรวจมือที่อนุมัติแล้ว';
  END IF;

  SELECT * INTO v_slip
  FROM public.ac_verified_slips
  WHERE id = p_verified_slip_id
    AND order_id = v_requested.order_id
    AND COALESCE(is_deleted, FALSE) = FALSE
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'รูปสลิปไม่ตรงกับบิลของรายการตรวจมือ';
  END IF;

  SELECT * INTO v_bank
  FROM public.bank_settings
  WHERE id = p_bank_setting_id AND is_active = TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบบัญชีธนาคารที่เปิดใช้งาน';
  END IF;

  v_response := p_result->'easyslip_response';
  v_api_success := COALESCE((p_result->>'success')::BOOLEAN, FALSE);
  v_error := NULLIF(trim(COALESCE(p_result->>'error', p_result->>'message', '')), '');
  v_amount_text := COALESCE(p_result->>'amount', v_response #>> '{data,amount,amount}');
  IF COALESCE(v_amount_text, '') ~ '^[0-9]+([.][0-9]+)?$' THEN
    v_amount := v_amount_text::NUMERIC;
  END IF;
  v_trans_ref := NULLIF(trim(COALESCE(v_response #>> '{data,transRef}', '')), '');
  v_date_text := NULLIF(trim(COALESCE(v_response #>> '{data,date}', '')), '');
  IF v_date_text IS NOT NULL THEN
    BEGIN
      v_payment_at := v_date_text::TIMESTAMPTZ;
    EXCEPTION WHEN OTHERS THEN
      v_payment_at := NULL;
    END;
  END IF;
  v_receiver_bank := NULLIF(trim(COALESCE(v_response #>> '{data,receiver,bank,id}', '')), '');
  v_receiver_account := NULLIF(trim(COALESCE(v_response #>> '{data,receiver,account,bank,account}', '')), '');

  v_bank_match := v_receiver_bank IS NOT NULL AND v_receiver_bank = v_bank.bank_code;
  v_account_match := v_receiver_account IS NOT NULL
    AND right(regexp_replace(v_receiver_account, '\D', '', 'g'), 4)
      = right(regexp_replace(v_bank.account_number, '\D', '', 'g'), 4);

  IF v_trans_ref IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.ac_verified_slips used
      WHERE used.id <> p_verified_slip_id
        AND COALESCE(used.is_deleted, FALSE) = FALSE
        AND NULLIF(trim(used.easyslip_trans_ref), '') = v_trans_ref
    ) INTO v_duplicate;
  END IF;

  -- Match the verified image to one unused manual transfer of the same bill and amount.
  -- When duplicate amounts exist, the closest manually entered transfer time wins.
  IF v_api_success AND v_amount IS NOT NULL THEN
    SELECT m.* INTO v_matched
    FROM public.ac_manual_slip_checks m
    WHERE m.order_id = v_requested.order_id
      AND m.status = 'approved'
      AND ABS(m.transfer_amount - v_amount) <= 0.01
      AND NOT EXISTS (
        SELECT 1 FROM public.ac_manual_slip_easyslip_retries r
        WHERE r.matched_manual_slip_id = m.id AND r.status = 'passed'
      )
    ORDER BY
      CASE WHEN v_payment_at IS NULL THEN 0 ELSE
        ABS(EXTRACT(EPOCH FROM (
          ((m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok') - v_payment_at
        )))
      END,
      m.submitted_at,
      m.id
    LIMIT 1
    FOR UPDATE OF m;
  END IF;

  IF NOT v_api_success THEN v_errors := array_append(v_errors, COALESCE(v_error, 'EasySlip ตรวจไม่สำเร็จ')); END IF;
  IF v_response IS NULL THEN v_errors := array_append(v_errors, 'ไม่พบข้อมูลตอบกลับจาก EasySlip'); END IF;
  IF v_payment_at IS NULL THEN v_errors := array_append(v_errors, 'ไม่พบวันเวลาโอนจาก EasySlip'); END IF;
  IF v_amount IS NULL THEN v_errors := array_append(v_errors, 'ไม่พบยอดเงินจาก EasySlip'); END IF;
  IF v_amount IS NOT NULL AND v_matched.id IS NULL THEN v_errors := array_append(v_errors, 'ไม่พบรายการตรวจมือยอดเดียวกันที่ยังไม่ได้จับกับรูปอื่น'); END IF;
  IF NOT v_bank_match THEN v_errors := array_append(v_errors, 'ธนาคารผู้รับไม่ตรงกับบัญชี Statement'); END IF;
  IF NOT v_account_match THEN v_errors := array_append(v_errors, 'เลขบัญชีผู้รับไม่ตรงกับบัญชี Statement'); END IF;
  IF v_duplicate THEN v_errors := array_append(v_errors, 'เลขอ้างอิง EasySlip ถูกใช้กับสลิปอื่นแล้ว'); END IF;

  v_pass := v_api_success
    AND v_response IS NOT NULL
    AND v_payment_at IS NOT NULL
    AND v_amount IS NOT NULL
    AND v_matched.id IS NOT NULL
    AND v_bank_match
    AND v_account_match
    AND NOT v_duplicate;

  UPDATE public.ac_verified_slips
  SET verified_amount = COALESCE(v_amount, verified_amount),
      easyslip_response = COALESCE(v_response, easyslip_response),
      easyslip_trans_ref = CASE WHEN v_pass THEN v_trans_ref ELSE NULL END,
      easyslip_date = CASE WHEN v_pass THEN v_payment_at ELSE NULL END,
      easyslip_receiver_bank_id = COALESCE(v_receiver_bank, easyslip_receiver_bank_id),
      easyslip_receiver_account = COALESCE(v_receiver_account, easyslip_receiver_account),
      is_validated = TRUE,
      validation_status = CASE WHEN v_pass THEN 'passed' ELSE 'failed' END,
      validation_errors = CASE WHEN v_pass THEN NULL ELSE v_errors END,
      expected_amount = CASE WHEN v_pass THEN v_matched.transfer_amount ELSE NULL END,
      expected_bank_account = v_bank.account_number,
      expected_bank_code = v_bank.bank_code,
      bank_code_match = v_bank_match,
      amount_match = v_pass
  WHERE id = p_verified_slip_id;

  INSERT INTO public.ac_manual_slip_easyslip_retries (
    order_id, requested_manual_slip_id, matched_manual_slip_id,
    verified_slip_id, status, checked_at, checked_by, error_message
  ) VALUES (
    v_requested.order_id, p_manual_slip_id,
    CASE WHEN v_pass THEN v_matched.id ELSE NULL END,
    p_verified_slip_id, CASE WHEN v_pass THEN 'passed' ELSE 'failed' END,
    now(), auth.uid(), CASE WHEN v_pass THEN NULL ELSE array_to_string(v_errors, ' | ') END
  )
  ON CONFLICT (verified_slip_id) DO UPDATE
  SET requested_manual_slip_id = EXCLUDED.requested_manual_slip_id,
      matched_manual_slip_id = EXCLUDED.matched_manual_slip_id,
      status = EXCLUDED.status,
      checked_at = EXCLUDED.checked_at,
      checked_by = EXCLUDED.checked_by,
      error_message = EXCLUDED.error_message;

  IF v_pass THEN
    UPDATE public.ac_manual_slip_checks
    SET easyslip_retry_status = 'passed',
        easyslip_retry_checked_at = now(),
        easyslip_retry_checked_by = auth.uid(),
        easyslip_retry_error = NULL,
        status = 'verified_by_easyslip'
    WHERE id = v_matched.id;
  ELSE
    UPDATE public.ac_manual_slip_checks
    SET easyslip_retry_status = 'failed',
        easyslip_retry_checked_at = now(),
        easyslip_retry_checked_by = auth.uid(),
        easyslip_retry_error = array_to_string(v_errors, ' | ')
    WHERE id = p_manual_slip_id AND status = 'approved';
  END IF;

  RETURN jsonb_build_object(
    'success', v_pass,
    'requested_manual_slip_id', p_manual_slip_id,
    'matched_manual_slip_id', CASE WHEN v_pass THEN v_matched.id ELSE NULL END,
    'verified_slip_id', p_verified_slip_id,
    'amount', v_amount,
    'payment_at', v_payment_at,
    'trans_ref', v_trans_ref,
    'errors', to_jsonb(v_errors)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bank_manual_slip_retry_easyslip(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_manual_slip_retry_easyslip(UUID, UUID, UUID, JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
