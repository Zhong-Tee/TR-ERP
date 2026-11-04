BEGIN;

-- Keep approved reviewer/time intact; revoked approvals use the existing rejected
-- state so payment reuse, bank matching and failed-queue queries exclude them.
ALTER TABLE public.ac_manual_slip_checks
  ADD COLUMN approval_revoked_at timestamptz,
  ADD COLUMN approval_revoked_by uuid REFERENCES public.us_users(id),
  ADD COLUMN approval_revoked_by_name text,
  ADD COLUMN approval_revoked_reason text;

CREATE FUNCTION public.guard_manual_slip_approval_revocation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF (OLD.status='approved' AND NEW.status IN ('rejected','pending'))
    OR NEW.approval_revoked_at IS DISTINCT FROM OLD.approval_revoked_at
    OR NEW.approval_revoked_by IS DISTINCT FROM OLD.approval_revoked_by
    OR NEW.approval_revoked_by_name IS DISTINCT FROM OLD.approval_revoked_by_name
    OR NEW.approval_revoked_reason IS DISTINCT FROM OLD.approval_revoked_reason THEN
    IF NOT EXISTS(SELECT 1 FROM public.us_users WHERE id=auth.uid() AND role='superadmin') THEN
      RAISE EXCEPTION 'เฉพาะ superadmin เท่านั้นที่ยกเลิกการอนุมัติสลิปมือได้';
    END IF;
    IF OLD.approval_revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'ไม่สามารถแก้ไขประวัติการยกเลิกการอนุมัติเดิมได้';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_manual_slip_approval_revocation BEFORE UPDATE ON public.ac_manual_slip_checks
  FOR EACH ROW EXECUTE FUNCTION public.guard_manual_slip_approval_revocation();
REVOKE ALL ON FUNCTION public.guard_manual_slip_approval_revocation() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.manual_slip_revoke_approval(p_order_id uuid,p_slip_ids uuid[],p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_actor text; v_order public.or_orders; v_ids uuid[]; v_count integer;
BEGIN
  SELECT coalesce(nullif(trim(username),''),email,id::text) INTO v_actor
    FROM public.us_users WHERE id=auth.uid() AND role='superadmin';
  IF NOT FOUND THEN RAISE EXCEPTION 'เฉพาะ superadmin เท่านั้นที่ยกเลิกการอนุมัติสลิปมือได้'; END IF;
  IF nullif(trim(p_reason),'') IS NULL OR length(p_reason)>1000 THEN
    RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ยกเลิกการอนุมัติ (ไม่เกิน 1,000 ตัวอักษร)';
  END IF;
  -- Match the parent-first locking used by payment reuse and manual decisions.
  SELECT * INTO v_order FROM public.or_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบบิล'; END IF;
  IF v_order.status IN ('ยกเลิก','จัดส่งแล้ว') OR v_order.shipped_time IS NOT NULL
    OR v_order.work_order_id IS NOT NULL OR nullif(trim(v_order.work_order_name),'') IS NOT NULL THEN
    RAISE EXCEPTION 'บิลถูกยกเลิก เข้าใบงาน หรือจัดส่งแล้ว ไม่สามารถยกเลิกการอนุมัติสลิปมือได้';
  END IF;
  PERFORM id FROM public.ac_manual_slip_checks WHERE order_id=p_order_id ORDER BY id FOR UPDATE;
  SELECT array_agg(id ORDER BY id) INTO v_ids FROM public.ac_manual_slip_checks
    WHERE order_id=p_order_id AND status='approved' AND duplicate_of IS NULL;
  IF coalesce(cardinality(v_ids),0)=0 THEN RAISE EXCEPTION 'ไม่พบสลิปมือที่อนุมัติแล้ว กรุณารีเฟรช'; END IF;
  IF p_slip_ids IS NULL OR cardinality(p_slip_ids)<>cardinality(v_ids)
    OR NOT (p_slip_ids @> v_ids AND v_ids @> p_slip_ids) THEN
    RAISE EXCEPTION 'รายการสลิปเปลี่ยนแปลงแล้ว กรุณารีเฟรชและตรวจสอบอีกครั้ง';
  END IF;
  IF EXISTS(SELECT 1 FROM public.ac_manual_slip_checks WHERE order_id=p_order_id AND status='pending') THEN
    RAISE EXCEPTION 'มีรายการรอตรวจสลิปมือ กรุณาจัดการรายการรอตรวจก่อน';
  END IF;
  IF EXISTS(SELECT 1 FROM public.ac_bank_reconciliation_allocations WHERE order_id=p_order_id)
    OR EXISTS(SELECT 1 FROM public.ac_order_receipt_certifications WHERE order_id=p_order_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'บิลนี้มีการจับคู่กระทบยอดหรือรับรองเงินรับแล้ว กรุณายกเลิกการจับคู่หรือการรับรองก่อน';
  END IF;
  UPDATE public.ac_manual_slip_checks
    SET status='rejected', rejected_reason='ยกเลิกการอนุมัติ: '||trim(p_reason),
      approval_revoked_at=now(), approval_revoked_by=auth.uid(),
      approval_revoked_by_name=v_actor, approval_revoked_reason=trim(p_reason)
    WHERE id=ANY(v_ids) AND status='approved';
  GET DIAGNOSTICS v_count=ROW_COUNT;
  -- Do not rewind order/production status or remove verified EasySlip evidence.
  RETURN jsonb_build_object('revoked_count',v_count,'order_status',v_order.status);
END $$;
REVOKE ALL ON FUNCTION public.manual_slip_revoke_approval(uuid,uuid[],text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.manual_slip_revoke_approval(uuid,uuid[],text) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
