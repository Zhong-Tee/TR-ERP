-- Keep cancelled bills out of the manual-slip queue and prevent an exact
-- EasySlip transaction reference from being submitted for manual approval.
BEGIN;

ALTER TABLE public.ac_manual_slip_checks
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submission_kind TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE public.ac_manual_slip_checks
  DROP CONSTRAINT IF EXISTS ac_manual_slip_checks_status_check;
ALTER TABLE public.ac_manual_slip_checks
  ADD CONSTRAINT ac_manual_slip_checks_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'));

ALTER TABLE public.ac_manual_slip_checks
  DROP CONSTRAINT IF EXISTS ac_manual_slip_checks_submission_kind_check;
ALTER TABLE public.ac_manual_slip_checks
  ADD CONSTRAINT ac_manual_slip_checks_submission_kind_check
  CHECK (submission_kind IN ('manual', 'duplicate_fallback_review'));

CREATE OR REPLACE FUNCTION public.tr_cancel_pending_manual_slips()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'ยกเลิก' AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE public.ac_manual_slip_checks
    SET status = 'cancelled',
        cancelled_at = now(),
        reviewed_at = COALESCE(reviewed_at, now()),
        reviewed_by = COALESCE(reviewed_by, 'ระบบ: บิลยกเลิก'),
        rejected_reason = NULL
    WHERE order_id = NEW.id
      AND status = 'pending';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cancel_pending_manual_slips ON public.or_orders;
CREATE TRIGGER trg_cancel_pending_manual_slips
AFTER UPDATE OF status ON public.or_orders
FOR EACH ROW EXECUTE FUNCTION public.tr_cancel_pending_manual_slips();

-- The failed queue should reopen only for a new pending request or a new
-- rejection, not when a cancelled bill automatically closes its request.
CREATE OR REPLACE FUNCTION public.reopen_failed_queue_from_manual_slip()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.status = 'pending')
     OR (TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'rejected') THEN
    PERFORM public.reopen_order_failed_queue(NEW.order_id);
  END IF;
  RETURN NEW;
END;
$$;

-- Close requests that were already orphaned before this migration. This runs
-- after replacing the failed-queue trigger function, so cancellation does not
-- accidentally reopen an archived failed item.
UPDATE public.ac_manual_slip_checks m
SET status = 'cancelled',
    cancelled_at = COALESCE(m.cancelled_at, now()),
    reviewed_at = COALESCE(m.reviewed_at, now()),
    reviewed_by = COALESCE(m.reviewed_by, 'ระบบ: บิลยกเลิก'),
    rejected_reason = NULL
FROM public.or_orders o
WHERE o.id = m.order_id
  AND o.status = 'ยกเลิก'
  AND m.status = 'pending';

CREATE OR REPLACE FUNCTION public.manual_slip_exact_duplicate_orders(p_order_ids UUID[])
RETURNS TABLE(order_id UUID, duplicate_order_id UUID, duplicate_bill_no TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT ON (current_slip.order_id)
    current_slip.order_id,
    used_slip.order_id,
    used_order.bill_no
  FROM public.ac_verified_slips current_slip
  JOIN public.ac_verified_slips used_slip
    ON NULLIF(trim(used_slip.easyslip_trans_ref), '') = NULLIF(trim(current_slip.easyslip_trans_ref), '')
   AND used_slip.order_id <> current_slip.order_id
   AND COALESCE(used_slip.is_deleted, false) = false
  JOIN public.or_orders used_order ON used_order.id = used_slip.order_id
  WHERE current_slip.order_id = ANY(COALESCE(p_order_ids, ARRAY[]::UUID[]))
    AND COALESCE(current_slip.is_deleted, false) = false
    AND NULLIF(trim(current_slip.easyslip_trans_ref), '') IS NOT NULL
    AND COALESCE(used_order.status, '') NOT IN ('รอลงข้อมูล', 'ลงข้อมูลผิด', 'ตรวจสอบไม่ผ่าน', 'ตรวจสอบไม่สำเร็จ', 'ยกเลิก')
    AND EXISTS (
      SELECT 1 FROM public.us_users actor
      WHERE actor.id = auth.uid()
        AND actor.role IN ('superadmin', 'admin', 'account', 'sales-tr', 'sales-pump', 'qc_order')
    )
  ORDER BY current_slip.order_id, used_slip.created_at DESC;
$$;

REVOKE ALL ON FUNCTION public.manual_slip_exact_duplicate_orders(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manual_slip_exact_duplicate_orders(UUID[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.manual_slip_submission_eligibility(p_order_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.or_orders;
  v_duplicate RECORD;
  v_has_duplicate_badge BOOLEAN := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.us_users actor
    WHERE actor.id = auth.uid()
      AND actor.role IN ('superadmin', 'admin', 'account', 'sales-tr', 'sales-pump', 'qc_order')
  ) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ตรวจสอบสถานะส่งสลิปมือ';
  END IF;

  SELECT * INTO v_order FROM public.or_orders WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบบิลที่ต้องการส่งตรวจ'; END IF;

  IF v_order.status = 'ยกเลิก' THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'cancelled_order');
  END IF;

  SELECT * INTO v_duplicate
  FROM public.manual_slip_exact_duplicate_orders(ARRAY[p_order_id])
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'exact_trans_ref_duplicate',
      'duplicate_order_id', v_duplicate.duplicate_order_id,
      'duplicate_bill_no', v_duplicate.duplicate_bill_no
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.ac_verified_slips s
    WHERE s.order_id = p_order_id
      AND COALESCE(s.is_deleted, false) = false
      AND EXISTS (
        SELECT 1 FROM unnest(COALESCE(s.validation_errors, ARRAY[]::TEXT[])) err
        WHERE err ILIKE '%สลิปซ้ำ%'
      )
  ) INTO v_has_duplicate_badge;

  RETURN jsonb_build_object(
    'allowed', true,
    'reason', CASE WHEN v_has_duplicate_badge THEN 'fallback_duplicate_review' ELSE 'normal' END,
    'requires_exception_review', v_has_duplicate_badge
  );
END;
$$;

REVOKE ALL ON FUNCTION public.manual_slip_submission_eligibility(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manual_slip_submission_eligibility(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.tr_guard_manual_slip_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_eligibility JSONB;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_eligibility := public.manual_slip_submission_eligibility(NEW.order_id);
    IF COALESCE((v_eligibility->>'allowed')::BOOLEAN, false) = false THEN
      IF v_eligibility->>'reason' = 'exact_trans_ref_duplicate' THEN
        RAISE EXCEPTION 'สลิปนี้ถูกใช้แล้วในบิล % ไม่สามารถส่งตรวจสลิปมือได้', COALESCE(v_eligibility->>'duplicate_bill_no', '-');
      END IF;
      RAISE EXCEPTION 'บิลถูกยกเลิกแล้ว ไม่สามารถส่งตรวจสลิปมือได้';
    END IF;
    NEW.submission_kind := CASE
      WHEN COALESCE((v_eligibility->>'requires_exception_review')::BOOLEAN, false)
        THEN 'duplicate_fallback_review'
      ELSE 'manual'
    END;
  ELSIF OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected')
        AND EXISTS (SELECT 1 FROM public.or_orders o WHERE o.id = NEW.order_id AND o.status = 'ยกเลิก') THEN
    RAISE EXCEPTION 'บิลถูกยกเลิกแล้ว ไม่สามารถอนุมัติหรือปฏิเสธได้';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_manual_slip_request ON public.ac_manual_slip_checks;
CREATE TRIGGER trg_guard_manual_slip_request
BEFORE INSERT OR UPDATE OF status ON public.ac_manual_slip_checks
FOR EACH ROW EXECUTE FUNCTION public.tr_guard_manual_slip_request();

CREATE OR REPLACE FUNCTION public.manual_slip_submit(p_order_id UUID, p_entries JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.or_orders;
  v_actor TEXT;
  v_role TEXT;
  v_eligibility JSONB;
  v_kind TEXT;
  v_count INTEGER;
BEGIN
  SELECT role, COALESCE(NULLIF(trim(username), ''), NULLIF(trim(email), ''), auth.uid()::TEXT)
  INTO v_role, v_actor
  FROM public.us_users
  WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'account', 'sales-tr', 'sales-pump') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ส่งตรวจสลิปมือ';
  END IF;

  SELECT * INTO v_order FROM public.or_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบบิลที่ต้องการส่งตรวจ'; END IF;

  v_eligibility := public.manual_slip_submission_eligibility(p_order_id);
  IF COALESCE((v_eligibility->>'allowed')::BOOLEAN, false) = false THEN
    IF v_eligibility->>'reason' = 'exact_trans_ref_duplicate' THEN
      RAISE EXCEPTION 'สลิปนี้ถูกใช้แล้วในบิล % ไม่สามารถส่งตรวจสลิปมือได้', COALESCE(v_eligibility->>'duplicate_bill_no', '-');
    END IF;
    RAISE EXCEPTION 'บิลถูกยกเลิกแล้ว ไม่สามารถส่งตรวจสลิปมือได้';
  END IF;

  IF EXISTS (SELECT 1 FROM public.ac_manual_slip_checks WHERE order_id = p_order_id AND status = 'pending') THEN
    RAISE EXCEPTION 'บิลนี้มีคำขอตรวจสลิปมือที่รอดำเนินการอยู่แล้ว';
  END IF;
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array'
     OR jsonb_array_length(p_entries) < 1 OR jsonb_array_length(p_entries) > 20 THEN
    RAISE EXCEPTION 'ข้อมูลสลิปต้องมี 1 ถึง 20 รายการ';
  END IF;

  v_kind := CASE WHEN COALESCE((v_eligibility->>'requires_exception_review')::BOOLEAN, false)
    THEN 'duplicate_fallback_review' ELSE 'manual' END;

  INSERT INTO public.ac_manual_slip_checks (
    order_id, bill_no, transfer_date, transfer_time, transfer_amount,
    submitted_by, status, submission_kind
  )
  SELECT
    p_order_id,
    v_order.bill_no,
    trim(entry.transfer_date),
    trim(entry.transfer_time),
    entry.transfer_amount,
    v_actor,
    'pending',
    v_kind
  FROM jsonb_to_recordset(p_entries) AS entry(
    transfer_date TEXT,
    transfer_time TEXT,
    transfer_amount NUMERIC
  )
  WHERE entry.transfer_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND entry.transfer_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND entry.transfer_amount > 0;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> jsonb_array_length(p_entries) THEN
    RAISE EXCEPTION 'วันที่ เวลา หรือยอดโอนในคำขอไม่ถูกต้อง';
  END IF;

  RETURN jsonb_build_object(
    'inserted_count', v_count,
    'submission_kind', v_kind,
    'requires_exception_review', v_kind = 'duplicate_fallback_review'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.manual_slip_submit(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manual_slip_submit(UUID, JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.manual_slip_decide(
  p_order_id UUID,
  p_action TEXT,
  p_rejected_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.or_orders;
  v_actor TEXT;
  v_role TEXT;
  v_new_order_status TEXT;
  v_count INTEGER;
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
    WHEN v_order.channel_code = 'PUMP' AND v_order.requires_confirm_design = false THEN 'ไม่ต้องออกแบบ'
    ELSE 'ตรวจสอบแล้ว'
  END;
  UPDATE public.or_orders SET status = v_new_order_status WHERE id = p_order_id;

  RETURN jsonb_build_object('updated_count', v_count, 'order_status', v_new_order_status);
END;
$$;

REVOKE ALL ON FUNCTION public.manual_slip_decide(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manual_slip_decide(UUID, TEXT, TEXT) TO authenticated;

-- Sales must submit through the atomic RPC; completed history is no longer
-- deleted before a replacement request is created.
DROP POLICY IF EXISTS "Sales can delete manual slip checks" ON public.ac_manual_slip_checks;

NOTIFY pgrst, 'reload schema';
COMMIT;
