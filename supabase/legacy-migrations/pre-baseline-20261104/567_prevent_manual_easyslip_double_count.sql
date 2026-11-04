-- Treat a manual check and an EasySlip result for the same transfer as one
-- payment, while blocking the same transfer from approving a different bill.
BEGIN;

CREATE OR REPLACE FUNCTION public.bank_sync_manual_verified_twins(p_order_id UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pair RECORD;
  v_updated INTEGER := 0;
  v_rows INTEGER := 0;
BEGIN
  FOR v_pair IN
    WITH candidates AS (
      SELECT
        m.id AS manual_id,
        m.order_id,
        s.id AS verified_id,
        ABS(EXTRACT(EPOCH FROM (
          ((m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
          - s.easyslip_date
        ))) AS diff_seconds
      FROM public.ac_manual_slip_checks m
      JOIN public.ac_verified_slips s
        ON s.order_id = m.order_id
       AND COALESCE(s.is_deleted, FALSE) = FALSE
       AND s.easyslip_date IS NOT NULL
       AND ABS(s.verified_amount - m.transfer_amount) <= 0.01
       AND s.easyslip_date >= ((m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok') - INTERVAL '10 minutes'
       AND s.easyslip_date <= ((m.transfer_date || ' ' || m.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok') + INTERVAL '10 minutes'
       AND (
         s.validation_status = 'passed'
         OR EXISTS (
           SELECT 1 FROM public.ac_bank_reconciliation_allocations allocation
           WHERE allocation.verified_slip_id = s.id
         )
       )
      WHERE m.status = 'approved'
        AND (p_order_id IS NULL OR m.order_id = p_order_id)
        AND m.transfer_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND m.transfer_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND NOT EXISTS (
          SELECT 1 FROM public.ac_manual_slip_easyslip_retries retry
          WHERE retry.status = 'passed'
            AND (retry.matched_manual_slip_id = m.id OR retry.verified_slip_id = s.id)
        )
    ), ranked AS (
      SELECT
        candidate.*,
        ROW_NUMBER() OVER (
          PARTITION BY candidate.manual_id
          ORDER BY candidate.diff_seconds, candidate.verified_id
        ) AS manual_rank,
        ROW_NUMBER() OVER (
          PARTITION BY candidate.verified_id
          ORDER BY candidate.diff_seconds, candidate.manual_id
        ) AS verified_rank
      FROM candidates candidate
    )
    SELECT * FROM ranked
    WHERE manual_rank = 1 AND verified_rank = 1
    ORDER BY diff_seconds, manual_id
  LOOP
    BEGIN
      INSERT INTO public.ac_manual_slip_easyslip_retries (
        order_id,
        requested_manual_slip_id,
        matched_manual_slip_id,
        verified_slip_id,
        status,
        checked_at,
        checked_by,
        error_message
      ) VALUES (
        v_pair.order_id,
        v_pair.manual_id,
        v_pair.manual_id,
        v_pair.verified_id,
        'passed',
        now(),
        auth.uid(),
        NULL
      )
      ON CONFLICT (verified_slip_id) DO UPDATE
      SET matched_manual_slip_id = EXCLUDED.matched_manual_slip_id,
          status = 'passed',
          checked_at = now(),
          checked_by = auth.uid(),
          error_message = NULL
      WHERE public.ac_manual_slip_easyslip_retries.status = 'failed';

      UPDATE public.ac_manual_slip_checks
      SET status = 'verified_by_easyslip',
          easyslip_retry_status = 'passed',
          easyslip_retry_checked_at = now(),
          easyslip_retry_checked_by = auth.uid(),
          easyslip_retry_error = NULL
      WHERE id = v_pair.manual_id
        AND status = 'approved'
        AND EXISTS (
          SELECT 1 FROM public.ac_manual_slip_easyslip_retries retry
          WHERE retry.matched_manual_slip_id = v_pair.manual_id
            AND retry.verified_slip_id = v_pair.verified_id
            AND retry.status = 'passed'
        );
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_updated := v_updated + v_rows;
    EXCEPTION WHEN unique_violation THEN
      -- A concurrent sync already claimed one side of this pair.
      NULL;
    END;
  END LOOP;

  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.bank_sync_manual_verified_twins(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tr_sync_manual_verified_twins()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'ac_manual_slip_checks' THEN
    IF NEW.status = 'approved' THEN
      PERFORM public.bank_sync_manual_verified_twins(NEW.order_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'ac_verified_slips' THEN
    IF NEW.easyslip_date IS NOT NULL AND NEW.validation_status = 'passed' THEN
      PERFORM public.bank_sync_manual_verified_twins(NEW.order_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'ac_bank_reconciliation_allocations' THEN
    IF NEW.verified_slip_id IS NOT NULL THEN
      PERFORM public.bank_sync_manual_verified_twins(NEW.order_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_manual_verified_twin_from_manual ON public.ac_manual_slip_checks;
CREATE TRIGGER trg_sync_manual_verified_twin_from_manual
AFTER INSERT OR UPDATE OF status, transfer_date, transfer_time, transfer_amount
ON public.ac_manual_slip_checks
FOR EACH ROW EXECUTE FUNCTION public.tr_sync_manual_verified_twins();

DROP TRIGGER IF EXISTS trg_sync_manual_verified_twin_from_verified ON public.ac_verified_slips;
CREATE TRIGGER trg_sync_manual_verified_twin_from_verified
AFTER INSERT OR UPDATE OF validation_status, easyslip_date, verified_amount
ON public.ac_verified_slips
FOR EACH ROW EXECUTE FUNCTION public.tr_sync_manual_verified_twins();

DROP TRIGGER IF EXISTS trg_sync_manual_verified_twin_from_allocation ON public.ac_bank_reconciliation_allocations;
CREATE TRIGGER trg_sync_manual_verified_twin_from_allocation
AFTER INSERT OR UPDATE OF verified_slip_id
ON public.ac_bank_reconciliation_allocations
FOR EACH ROW EXECUTE FUNCTION public.tr_sync_manual_verified_twins();

-- A bank statement transaction is one real movement and may not fund two bills.
CREATE OR REPLACE FUNCTION public.tr_guard_single_bank_transaction_allocation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.ac_bank_reconciliation_allocations existing
    WHERE existing.transaction_id = NEW.transaction_id
      AND existing.id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'รายการเงินเข้าใน Statement นี้ถูกจับคู่กับบิลอื่นแล้ว';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_single_bank_transaction_allocation ON public.ac_bank_reconciliation_allocations;
CREATE TRIGGER trg_guard_single_bank_transaction_allocation
BEFORE INSERT OR UPDATE OF transaction_id
ON public.ac_bank_reconciliation_allocations
FOR EACH ROW EXECUTE FUNCTION public.tr_guard_single_bank_transaction_allocation();

-- Recheck duplicates inside the approval transaction. The previous screen-level
-- duplicate check was informative only and could be bypassed.
CREATE OR REPLACE FUNCTION public.manual_slip_decide(
  p_order_id UUID,
  p_action TEXT,
  p_rejected_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.or_orders;
  v_actor TEXT;
  v_role TEXT;
  v_new_order_status TEXT;
  v_count INTEGER;
  v_duplicate_bill_no TEXT;
  v_eligibility JSONB;
BEGIN
  SELECT role, COALESCE(NULLIF(trim(username), ''), NULLIF(trim(email), ''), auth.uid()::TEXT)
  INTO v_role, v_actor
  FROM public.us_users
  WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'account') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ตัดสินผลตรวจสลิปมือ';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'ผลการตรวจสลิปไม่ถูกต้อง';
  END IF;

  SELECT * INTO v_order FROM public.or_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบบิลที่ต้องการตรวจ'; END IF;
  IF v_order.status = 'ยกเลิก' THEN
    RAISE EXCEPTION 'บิลถูกยกเลิกแล้ว ไม่สามารถอนุมัติหรือปฏิเสธได้';
  END IF;

  IF p_action = 'approved' THEN
    v_eligibility := public.manual_slip_submission_eligibility(p_order_id);
    IF COALESCE((v_eligibility->>'allowed')::BOOLEAN, FALSE) = FALSE
       AND v_eligibility->>'reason' = 'exact_trans_ref_duplicate'
    THEN
      RAISE EXCEPTION 'สลิปนี้ถูกใช้แล้วในบิล % ไม่สามารถอนุมัติตรวจมือได้',
        COALESCE(v_eligibility->>'duplicate_bill_no', '-');
    END IF;

    SELECT duplicate_order.bill_no
    INTO v_duplicate_bill_no
    FROM public.ac_manual_slip_checks pending
    JOIN public.ac_verified_slips slip
      ON slip.order_id <> pending.order_id
     AND COALESCE(slip.is_deleted, FALSE) = FALSE
     AND slip.easyslip_date IS NOT NULL
     AND slip.validation_status = 'passed'
     AND ABS(slip.verified_amount - pending.transfer_amount) <= 0.01
     AND date_trunc('minute', slip.easyslip_date)
         = date_trunc('minute', (pending.transfer_date || ' ' || pending.transfer_time)::TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
    JOIN public.or_orders duplicate_order ON duplicate_order.id = slip.order_id
    WHERE pending.order_id = p_order_id
      AND pending.status = 'pending'
      AND pending.transfer_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      AND pending.transfer_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND COALESCE(duplicate_order.status, '') NOT IN (
        'รอลงข้อมูล', 'ลงข้อมูลผิด', 'ตรวจสอบไม่ผ่าน', 'ตรวจสอบไม่สำเร็จ', 'ยกเลิก'
      )
    ORDER BY slip.created_at DESC
    LIMIT 1;

    IF v_duplicate_bill_no IS NOT NULL THEN
      RAISE EXCEPTION 'ยอดและเวลาโอนตรงกับ EasySlip ที่ใช้ในบิล % ไม่สามารถอนุมัติตรวจมือได้', v_duplicate_bill_no;
    END IF;
  END IF;

  UPDATE public.ac_manual_slip_checks
  SET status = p_action,
      reviewed_by = v_actor,
      reviewed_at = now(),
      rejected_reason = CASE WHEN p_action = 'rejected' THEN NULLIF(trim(p_rejected_reason), '') ELSE NULL END
  WHERE order_id = p_order_id AND status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN RAISE EXCEPTION 'ไม่พบคำขอตรวจสลิปที่รอดำเนินการ'; END IF;

  v_new_order_status := CASE
    WHEN p_action = 'rejected' THEN 'ตรวจสอบไม่ผ่าน'
    WHEN v_order.channel_code = 'PUMP' AND v_order.requires_confirm_design = FALSE THEN 'ไม่ต้องออกแบบ'
    ELSE 'ตรวจสอบแล้ว'
  END;
  UPDATE public.or_orders SET status = v_new_order_status WHERE id = p_order_id;

  RETURN jsonb_build_object('updated_count', v_count, 'order_status', v_new_order_status);
END;
$$;

REVOKE ALL ON FUNCTION public.manual_slip_decide(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manual_slip_decide(UUID, TEXT, TEXT) TO authenticated;

-- Backfill high-confidence same-bill twins. No rows are deleted; the manual
-- audit record is retained with status verified_by_easyslip.
SELECT public.bank_sync_manual_verified_twins(NULL);

NOTIFY pgrst, 'reload schema';
COMMIT;
