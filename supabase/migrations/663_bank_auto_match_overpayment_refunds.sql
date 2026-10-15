BEGIN;

-- A manually removed pair must not reappear on the next automatic refresh.
CREATE TABLE public.ac_bank_refund_auto_match_exclusions (
  refund_id UUID PRIMARY KEY REFERENCES public.ac_refunds(id),
  excluded_by UUID NOT NULL REFERENCES public.us_users(id),
  excluded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.ac_bank_refund_auto_match_exclusions ENABLE ROW LEVEL SECURITY;

ALTER FUNCTION public.bank_match_overpayment_refund(UUID,UUID,BOOLEAN)
  RENAME TO bank_match_overpayment_refund_manual_impl;
REVOKE ALL ON FUNCTION public.bank_match_overpayment_refund_manual_impl(UUID,UUID,BOOLEAN) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.bank_match_overpayment_refund(p_order_id UUID,p_refund_id UUID,p_remove BOOLEAN DEFAULT false)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.bank_match_overpayment_refund_manual_impl(p_order_id,p_refund_id,p_remove);
  IF p_remove THEN
    INSERT INTO public.ac_bank_refund_auto_match_exclusions(refund_id,excluded_by)
    VALUES(p_refund_id,auth.uid()) ON CONFLICT(refund_id) DO UPDATE
      SET excluded_by=EXCLUDED.excluded_by,excluded_at=now();
  ELSE
    DELETE FROM public.ac_bank_refund_auto_match_exclusions WHERE refund_id=p_refund_id;
  END IF;
END $$;

CREATE FUNCTION public.bank_auto_match_overpayment_refunds(p_order_ids UUID[])
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_order public.or_orders; v_info JSONB; v_refund_id UUID; v_candidates BIGINT;
  v_count INTEGER := 0; v_amounts JSONB := '{}'::JSONB;
BEGIN
  PERFORM public.bank_reconciliation_require_authorized_role();
  IF COALESCE(cardinality(p_order_ids),0)>50 THEN RAISE EXCEPTION 'จับคู่อัตโนมัติได้ครั้งละไม่เกิน 50 บิล'; END IF;
  -- Use the same order as manual matching to serialize simultaneous requests.
  FOR v_order IN SELECT * FROM public.or_orders WHERE id=ANY(p_order_ids)
    ORDER BY id FOR UPDATE
  LOOP
    IF COALESCE(v_order.status,'') IN ('ยกเลิก','รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ') THEN CONTINUE; END IF;
    -- Lock same-bill refunds before testing uniqueness, including pending requests.
    -- Two approved refunds for the exact amount are ambiguous: leave both for manual selection.
    PERFORM id FROM public.ac_refunds WHERE order_id=v_order.id ORDER BY id FOR UPDATE;
    v_info := public.bank_overpayment_refunds(v_order.id);
    SELECT count(*),(array_agg(r.id ORDER BY r.id))[1] INTO v_candidates,v_refund_id
    FROM public.ac_refunds r
    WHERE r.order_id=v_order.id AND r.status='approved'
      AND r.amount=(v_info->>'remaining')::NUMERIC AND r.amount>0.01
      AND NOT EXISTS(SELECT 1 FROM public.ac_bank_overpayment_refund_matches m WHERE m.refund_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM public.ac_bank_refund_auto_match_exclusions e WHERE e.refund_id=r.id);
    IF v_candidates=1 THEN
      PERFORM public.bank_match_overpayment_refund(v_order.id,v_refund_id);
      v_count := v_count+1;
    END IF;
    SELECT v_amounts || jsonb_build_object(v_order.id::TEXT,COALESCE(sum(r.amount),0)) INTO v_amounts
    FROM public.ac_bank_overpayment_refund_matches m JOIN public.ac_refunds r ON r.id=m.refund_id
    WHERE m.order_id=v_order.id;
  END LOOP;
  RETURN jsonb_build_object('matched_count',v_count,'amounts',v_amounts);
END $$;

REVOKE ALL ON FUNCTION public.bank_match_overpayment_refund(UUID,UUID,BOOLEAN),public.bank_auto_match_overpayment_refunds(UUID[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.bank_match_overpayment_refund(UUID,UUID,BOOLEAN),public.bank_auto_match_overpayment_refunds(UUID[]) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
