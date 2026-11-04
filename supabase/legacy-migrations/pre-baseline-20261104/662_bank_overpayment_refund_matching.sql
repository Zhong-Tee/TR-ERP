BEGIN;

CREATE TABLE public.ac_bank_overpayment_refund_matches (
  refund_id UUID PRIMARY KEY REFERENCES public.ac_refunds(id),
  order_id UUID NOT NULL REFERENCES public.or_orders(id),
  matched_by UUID NOT NULL REFERENCES public.us_users(id),
  matched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON public.ac_bank_overpayment_refund_matches(order_id);
ALTER TABLE public.ac_bank_overpayment_refund_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY refund_match_read ON public.ac_bank_overpayment_refund_matches
FOR SELECT TO authenticated USING (EXISTS (
  SELECT 1 FROM public.us_users WHERE id = auth.uid() AND role IN ('superadmin', 'account')
));

CREATE FUNCTION public.bank_overpayment_refunds(p_order_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_excess NUMERIC; v_matched NUMERIC; v_result JSONB;
BEGIN
  PERFORM public.bank_reconciliation_require_authorized_role();
  SELECT greatest(0,
    COALESCE((SELECT sum(allocated_amount) FROM public.ac_bank_reconciliation_allocations WHERE order_id=o.id),0)
    + COALESCE((SELECT sum(amount) FROM public.ac_order_receipt_certifications WHERE order_id=o.id AND revoked_at IS NULL),0)
    - o.total_amount) INTO v_excess FROM public.or_orders o WHERE o.id=p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบบิล'; END IF;
  SELECT COALESCE(sum(r.amount),0) INTO v_matched FROM public.ac_bank_overpayment_refund_matches m
    JOIN public.ac_refunds r ON r.id=m.refund_id WHERE m.order_id=p_order_id;
  SELECT jsonb_build_object('excess',v_excess,'matched_amount',v_matched,
    'remaining',greatest(0,v_excess-v_matched),
    'refunds',COALESCE(jsonb_agg(jsonb_build_object(
      'id',r.id,'amount',r.amount,'created_at',r.created_at,
      'recipient',r.refund_recipient_account_name,'bank',r.refund_recipient_bank,
      'account_number',r.refund_recipient_account_number,'reason',r.refund_recipient_reason,
      'has_slip',COALESCE(cardinality(r.refund_slip_paths),0)>0,
      'sent',r.refund_slip_sent_at IS NOT NULL,'matched_at',m.matched_at
    ) ORDER BY r.created_at DESC,r.id),'[]'::JSONB)) INTO v_result
  FROM public.ac_refunds r LEFT JOIN public.ac_bank_overpayment_refund_matches m ON m.refund_id=r.id
  WHERE r.order_id=p_order_id AND (r.status='approved' OR m.refund_id IS NOT NULL);
  RETURN v_result;
END $$;

CREATE FUNCTION public.bank_match_overpayment_refund(p_order_id UUID,p_refund_id UUID,p_remove BOOLEAN DEFAULT false)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_refund public.ac_refunds; v_order public.or_orders; v_info JSONB;
BEGIN
  PERFORM public.bank_reconciliation_require_authorized_role();
  -- Serialize matches for a bill and lock the refund against concurrent approval changes.
  SELECT * INTO v_order FROM public.or_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบบิล'; END IF;
  SELECT * INTO v_refund FROM public.ac_refunds WHERE id=p_refund_id FOR UPDATE;
  IF NOT FOUND OR v_refund.order_id<>p_order_id THEN RAISE EXCEPTION 'รายการโอนคืนต้องเป็นของบิลเดียวกัน'; END IF;
  IF p_remove THEN
    DELETE FROM public.ac_bank_overpayment_refund_matches WHERE order_id=p_order_id AND refund_id=p_refund_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบรายการที่จับคู่'; END IF;
    RETURN;
  END IF;
  IF v_refund.status<>'approved' OR v_refund.amount IS NULL OR v_refund.amount<=0 THEN
    RAISE EXCEPTION 'กรุณาเลือกรายการโอนคืนที่อนุมัติแล้วและมียอดมากกว่าศูนย์';
  END IF;
  IF COALESCE(v_order.status,'') IN ('ยกเลิก','รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ') THEN
    RAISE EXCEPTION 'สถานะบิลนี้ไม่สามารถจับคู่ได้';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ac_bank_overpayment_refund_matches WHERE refund_id=p_refund_id) THEN
    RAISE EXCEPTION 'รายการโอนคืนนี้ถูกจับคู่แล้ว กรุณารีเฟรช';
  END IF;
  v_info := public.bank_overpayment_refunds(p_order_id);
  IF (v_info->>'excess')::NUMERIC<=0.01 OR v_refund.amount>(v_info->>'remaining')::NUMERIC THEN
    RAISE EXCEPTION 'ยอดโอนคืนเกินยอดรับเกินที่ยังไม่ได้จับคู่ กรุณารีเฟรชและตรวจสอบยอด';
  END IF;
  INSERT INTO public.ac_bank_overpayment_refund_matches(refund_id,order_id,matched_by)
    VALUES(p_refund_id,p_order_id,auth.uid());
END $$;

REVOKE ALL ON FUNCTION public.bank_overpayment_refunds(UUID),public.bank_match_overpayment_refund(UUID,UUID,BOOLEAN) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.bank_overpayment_refunds(UUID),public.bank_match_overpayment_refund(UUID,UUID,BOOLEAN) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
