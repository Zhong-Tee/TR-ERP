BEGIN;

-- Customer decisions without a payout are separate from refunds: no outgoing
-- payment, refund slip, or trial-balance refund is created for these requests.
CREATE TABLE public.ac_overpayment_waivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.or_orders(id),
  amount numeric(12,2) NOT NULL CHECK(amount>0),
  order_total numeric(12,2) NOT NULL,
  paid_amount numeric(12,2) NOT NULL,
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  evidence_url text NOT NULL CHECK(evidence_url ~ '^https?://[^[:space:]]+$'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','superseded')),
  created_by uuid NOT NULL REFERENCES public.us_users(id),
  created_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES public.us_users(id),
  reviewed_by_name text,
  reviewed_at timestamptz,
  rejected_reason text,
  invalidated_at timestamptz
);
CREATE UNIQUE INDEX ac_overpayment_waiver_active ON public.ac_overpayment_waivers(order_id) WHERE status IN ('pending','approved');
ALTER TABLE public.ac_overpayment_waivers ENABLE ROW LEVEL SECURITY;
CREATE POLICY waiver_read ON public.ac_overpayment_waivers FOR SELECT TO authenticated
  USING (EXISTS(SELECT 1 FROM public.or_orders o WHERE o.id=order_id));
REVOKE ALL ON public.ac_overpayment_waivers FROM anon,authenticated;
GRANT SELECT ON public.ac_overpayment_waivers TO authenticated;

-- Same transaction must not count twice when a manual slip also has EasySlip data.
CREATE FUNCTION public.or_overpayment_paid(p_order_id uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT sum(verified_amount) FROM ac_verified_slips WHERE order_id=p_order_id AND NOT coalesce(is_deleted,false)),0)
  +coalesce((SELECT sum(m.transfer_amount) FROM ac_manual_slip_checks m WHERE m.order_id=p_order_id
    AND m.status='approved' AND m.duplicate_of IS NULL
    AND NOT EXISTS(SELECT 1 FROM ac_verified_slips s WHERE s.order_id=m.order_id AND NOT coalesce(s.is_deleted,false)
      AND s.verified_amount=m.transfer_amount AND s.easyslip_date IS NOT NULL
      AND to_char(s.easyslip_date AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD')=trim(m.transfer_date)
      AND to_char(s.easyslip_date AT TIME ZONE 'Asia/Bangkok','HH24:MI')=trim(m.transfer_time))),0)
$$;
CREATE FUNCTION public.or_approved_waiver_amount(p_order_id uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(sum(w.amount),0) FROM ac_overpayment_waivers w JOIN or_orders o ON o.id=w.order_id
 WHERE w.order_id=p_order_id AND w.status='approved' AND w.order_total=o.total_amount
   AND w.paid_amount=public.or_overpayment_paid(o.id)
$$;
CREATE FUNCTION public.or_approved_overpayment_amount(p_order_id uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT sum(amount) FROM ac_refunds WHERE order_id=p_order_id AND status='approved' AND reason ILIKE '%โอนเกิน%'),0)
   +public.or_approved_waiver_amount(p_order_id)
$$;
REVOKE ALL ON FUNCTION public.or_overpayment_paid(uuid),public.or_approved_waiver_amount(uuid),public.or_approved_overpayment_amount(uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.or_supersede_stale_waivers(p_order_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 UPDATE ac_overpayment_waivers w SET status='superseded',invalidated_at=now()
 FROM or_orders o WHERE w.order_id=o.id AND w.order_id=p_order_id AND w.status='approved'
  AND (w.order_total<>o.total_amount OR w.paid_amount<>public.or_overpayment_paid(o.id))
$$;
REVOKE ALL ON FUNCTION public.or_supersede_stale_waivers(uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.submit_overpayment_waiver(p_order_id uuid,p_reason text,p_evidence_url text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_order public.or_orders; v_user public.us_users; v_paid numeric; v_amount numeric; v_id uuid; v_owner_role text; v_next text;
BEGIN
  SELECT * INTO v_user FROM us_users WHERE id=auth.uid();
  IF v_user.role IS NULL OR v_user.role NOT IN ('superadmin','admin','admin-tr','account','order_staff','sales-tr','sales-pump') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ส่งคำขอไม่รับเงินคืน';
  END IF;
  IF nullif(trim(p_reason),'') IS NULL OR length(p_reason)>1000 OR p_evidence_url IS NULL
    OR trim(p_evidence_url) !~ '^https?://[^[:space:]]+$' THEN
    RAISE EXCEPTION 'กรุณาระบุเหตุผลและลิงก์หลักฐานที่ลูกค้ายืนยันไม่รับเงินคืน';
  END IF;
  SELECT * INTO v_order FROM or_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบบิล'; END IF;
  IF v_user.role IN ('sales-tr','sales-pump') AND v_order.admin_user IS DISTINCT FROM v_user.username
    AND v_order.admin_user IS DISTINCT FROM v_user.email THEN RAISE EXCEPTION 'ไม่มีสิทธิ์จัดการบิลนี้'; END IF;
  IF v_order.status='ยกเลิก' THEN RAISE EXCEPTION 'บิลถูกยกเลิกแล้ว'; END IF;
  PERFORM public.or_supersede_stale_waivers(p_order_id);
  IF EXISTS(SELECT 1 FROM ac_refunds WHERE order_id=p_order_id AND status IN ('pending','approved') AND reason ILIKE '%โอนเกิน%') THEN
    RAISE EXCEPTION 'บิลนี้มีคำขอโอนคืนแล้ว กรุณาจัดการคำขอเดิมก่อน';
  END IF;
  IF EXISTS(SELECT 1 FROM ac_overpayment_waivers WHERE order_id=p_order_id AND status IN ('pending','approved')) THEN
    RAISE EXCEPTION 'บิลนี้มีคำขอไม่รับเงินคืนที่รอพิจารณาหรืออนุมัติแล้ว';
  END IF;
  v_paid:=public.or_overpayment_paid(p_order_id); v_amount:=v_paid-v_order.total_amount;
  IF v_amount<=0.01 THEN RAISE EXCEPTION 'ไม่พบยอดโอนเกินที่ต้องจัดการ'; END IF;
  INSERT INTO ac_overpayment_waivers(order_id,amount,order_total,paid_amount,reason,evidence_url,created_by,created_by_name)
    VALUES(p_order_id,v_amount,v_order.total_amount,v_paid,trim(p_reason),trim(p_evidence_url),auth.uid(),coalesce(v_user.username,v_user.email,v_user.id::text)) RETURNING id INTO v_id;
  SELECT role INTO v_owner_role FROM us_users WHERE username=v_order.admin_user OR email=v_order.admin_user
    ORDER BY (username=v_order.admin_user) DESC NULLS LAST LIMIT 1;
  v_next:=CASE WHEN upper(trim(v_order.channel_code))='WY' THEN 'ตรวจสอบแล้ว'
    WHEN v_owner_role='sales-tr' AND ((v_order.channel_code='PUMP' AND v_order.requires_confirm_design=FALSE)
      OR (v_order.channel_code IS DISTINCT FROM 'PUMP' AND coalesce(v_order.requires_confirm_design,FALSE)=FALSE)) THEN 'รอตรวจคำสั่งซื้อ'
    WHEN v_order.channel_code='PUMP' AND v_order.requires_confirm_design=FALSE THEN 'ไม่ต้องออกแบบ'
    ELSE 'ตรวจสอบแล้ว' END;
  PERFORM public.or_apply_payment_review_status(p_order_id,v_next,'overpayment_request');
  RETURN v_id;
END $$;
CREATE FUNCTION public.decide_overpayment_waiver(p_id uuid,p_action text,p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_order_id uuid; v_order public.or_orders; v_request public.ac_overpayment_waivers;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM us_users WHERE id=auth.uid() AND role IN ('superadmin','account','admin','admin-tr')) THEN
    RAISE EXCEPTION 'เฉพาะบัญชีหรือผู้ดูแลเท่านั้นที่พิจารณาได้';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'ผลการพิจารณาไม่ถูกต้อง'; END IF;
  IF p_action='rejected' AND nullif(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ไม่อนุมัติ'; END IF;
  SELECT order_id INTO v_order_id FROM ac_overpayment_waivers WHERE id=p_id;
  SELECT * INTO v_order FROM or_orders WHERE id=v_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบคำขอ'; END IF;
  SELECT * INTO v_request FROM ac_overpayment_waivers WHERE id=p_id FOR UPDATE;
  IF v_request.status<>'pending' THEN RAISE EXCEPTION 'คำขอนี้ถูกพิจารณาแล้ว กรุณารีเฟรช'; END IF;
  IF p_action='approved' THEN
    IF v_order.status='ยกเลิก' OR v_request.order_total<>v_order.total_amount
      OR v_request.paid_amount<>public.or_overpayment_paid(v_order_id)
      OR v_request.amount<>v_request.paid_amount-v_order.total_amount THEN
      RAISE EXCEPTION 'ยอดบิลหรือยอดรับเปลี่ยนแปลง กรุณาปฏิเสธและให้ฝ่ายขายส่งคำขอใหม่';
    END IF;
    IF EXISTS(SELECT 1 FROM ac_refunds WHERE order_id=v_order_id AND status IN ('pending','approved') AND reason ILIKE '%โอนเกิน%') THEN
      RAISE EXCEPTION 'บิลนี้มีคำขอโอนคืนที่ยังใช้งานอยู่';
    END IF;
  END IF;
  UPDATE ac_overpayment_waivers SET status=p_action,reviewed_by=auth.uid(),reviewed_at=now(),
    reviewed_by_name=(SELECT coalesce(username,email,id::text) FROM us_users WHERE id=auth.uid()),
    rejected_reason=CASE WHEN p_action='rejected' THEN trim(p_reason) END WHERE id=p_id;
END $$;
REVOKE ALL ON FUNCTION public.submit_overpayment_waiver(uuid,text,text),public.decide_overpayment_waiver(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.submit_overpayment_waiver(uuid,text,text),public.decide_overpayment_waiver(uuid,text,text) TO authenticated;

-- Serialize both alternatives on the same order; never allow a payout and a
-- customer waiver to resolve the same money concurrently.
CREATE FUNCTION public.guard_refund_against_waiver() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM id FROM or_orders WHERE id=NEW.order_id FOR UPDATE;
  PERFORM public.or_supersede_stale_waivers(NEW.order_id);
  IF NEW.status IN ('pending','approved') AND NEW.reason ILIKE '%โอนเกิน%'
    AND EXISTS(SELECT 1 FROM ac_overpayment_waivers WHERE order_id=NEW.order_id AND status IN ('pending','approved')) THEN
    RAISE EXCEPTION 'บิลนี้มีคำขอไม่รับเงินคืนแล้ว ไม่สามารถสร้างหรืออนุมัติโอนคืนซ้ำได้';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_refund_against_waiver BEFORE INSERT OR UPDATE ON public.ac_refunds
  FOR EACH ROW EXECUTE FUNCTION public.guard_refund_against_waiver();
REVOKE ALL ON FUNCTION public.guard_refund_against_waiver() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.or_refund_production_block(p_order_id uuid,p_total numeric)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_latest record; v_remaining numeric;
BEGIN
  IF EXISTS(SELECT 1 FROM ac_refunds WHERE order_id=p_order_id AND status='pending') THEN RETURN 'รออนุมัติคำขอโอนคืน'; END IF;
  IF EXISTS(SELECT 1 FROM ac_overpayment_waivers WHERE order_id=p_order_id AND status='pending') THEN RETURN 'รอบัญชีรับรองลูกค้าไม่รับเงินคืน'; END IF;
  SELECT * INTO v_latest FROM (
    SELECT status,rejected_reason,created_at,id FROM ac_refunds WHERE order_id=p_order_id
    UNION ALL SELECT status,rejected_reason,created_at,id FROM ac_overpayment_waivers WHERE order_id=p_order_id
  ) r ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_latest.status='rejected' THEN RETURN 'คำขอจัดการยอดเกินถูกปฏิเสธ: '||coalesce(v_latest.rejected_reason,'กรุณาแก้ไขและส่งคำขอใหม่'); END IF;
  -- p_total may be NEW.total_amount in a BEFORE trigger, before the row is stored.
  v_remaining:=public.or_overpayment_paid(p_order_id)-coalesce(p_total,0)
    -coalesce((SELECT sum(amount) FROM ac_refunds WHERE order_id=p_order_id AND status='approved' AND reason ILIKE '%โอนเกิน%'),0)
    -coalesce((SELECT sum(amount) FROM ac_overpayment_waivers WHERE order_id=p_order_id AND status='approved'
      AND order_total=p_total AND paid_amount=public.or_overpayment_paid(p_order_id)),0);
  IF v_remaining>0.01 THEN RETURN 'พบยอดโอนเกิน '||to_char(v_remaining,'FM999999999990.00')||' บาท ยังไม่ได้รับอนุมัติการจัดการยอดเกิน'; END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.bank_auto_match_order_has_capacity(p_order_id uuid,p_amount numeric)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM or_orders o WHERE o.id=p_order_id
  AND coalesce(o.status,'') NOT IN ('รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ','ยกเลิก')
  AND coalesce((SELECT sum(allocated_amount) FROM ac_bank_reconciliation_allocations WHERE order_id=o.id),0)
    +coalesce((SELECT sum(amount) FROM ac_order_receipt_certifications WHERE order_id=o.id AND revoked_at IS NULL),0)
    <o.total_amount+public.or_approved_overpayment_amount(o.id)-0.01
  AND coalesce((SELECT sum(allocated_amount) FROM ac_bank_reconciliation_allocations WHERE order_id=o.id),0)
    +coalesce((SELECT sum(amount) FROM ac_order_receipt_certifications WHERE order_id=o.id AND revoked_at IS NULL),0)
    +p_amount<=o.total_amount+public.or_approved_overpayment_amount(o.id)+0.01)
$$;
-- Preserve the established matching/ambiguity checks and only expand the cap
-- in the two statement matching paths. Fail rather than patch an unknown body.
DO $$ DECLARE v_sig text; v_sql text; v_new text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY['public.bank_statement_auto_match_authorized_impl(uuid)','public.bank_workspace_auto_match(date,date,uuid)'] LOOP
    v_sql:=pg_get_functiondef(v_sig::regprocedure);
    v_new:=replace(v_sql,'> o.total_amount + 0.01)', '> o.total_amount + public.or_approved_overpayment_amount(o.id) + 0.01)');
    IF v_new=v_sql THEN RAISE EXCEPTION 'Unknown bank matching body: %',v_sig; END IF;
    EXECUTE v_new;
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.tr_guard_bank_certified_allocation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_total numeric; v_cert numeric; v_bank numeric;
BEGIN
 SELECT total_amount INTO v_total FROM or_orders WHERE id=NEW.order_id FOR UPDATE;
 SELECT coalesce(sum(amount),0) INTO v_cert FROM ac_order_receipt_certifications WHERE order_id=NEW.order_id AND revoked_at IS NULL;
 IF v_cert>0 THEN
  SELECT coalesce(sum(allocated_amount),0) INTO v_bank FROM ac_bank_reconciliation_allocations WHERE order_id=NEW.order_id AND id<>NEW.id;
  IF v_cert+v_bank+NEW.allocated_amount>v_total+public.or_approved_overpayment_amount(NEW.order_id)+0.01 THEN
    RAISE EXCEPTION 'บิลมีการรับรองเงินรับแล้ว กรุณายกเลิกหรือปรับการรับรองก่อนจับคู่เพื่อไม่ให้นับเงินซ้ำ';
  END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.tr_guard_fully_allocated_bank_bill() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_bill_no text; v_limit numeric; v_allocated numeric;
BEGIN
 SELECT bill_no,total_amount INTO v_bill_no,v_limit FROM or_orders WHERE id=NEW.order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบบิลที่ต้องการจับคู่'; END IF;
 v_limit:=coalesce(v_limit,0)+public.or_approved_overpayment_amount(NEW.order_id);
 SELECT coalesce(sum(allocated_amount),0) INTO v_allocated FROM ac_bank_reconciliation_allocations
   WHERE order_id=NEW.order_id AND id IS DISTINCT FROM NEW.id;
 IF v_allocated>=v_limit-0.01 THEN
   RAISE EXCEPTION 'เลขบิล % ถูกจับคู่ครบตามยอดที่อนุมัติแล้ว กรุณายกเลิกคู่เดิมก่อนหากต้องการเปลี่ยนรายการ',v_bill_no;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.bank_reconciliation_bill_match_availability(p_bill_no text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_order public.or_orders; v_allocated numeric; v_limit numeric;
BEGIN
 PERFORM public.bank_reconciliation_require_authorized_role();
 SELECT * INTO v_order FROM or_orders WHERE upper(trim(bill_no))=upper(trim(p_bill_no)) AND status<>'ยกเลิก' LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบบิล หรือบิลถูกยกเลิก'; END IF;
 SELECT coalesce(sum(allocated_amount),0) INTO v_allocated FROM ac_bank_reconciliation_allocations WHERE order_id=v_order.id;
 v_allocated:=v_allocated+coalesce((SELECT sum(amount) FROM ac_order_receipt_certifications WHERE order_id=v_order.id AND revoked_at IS NULL),0);
 v_limit:=coalesce(v_order.total_amount,0)+public.or_approved_overpayment_amount(v_order.id);
 RETURN jsonb_build_object('available',v_allocated<v_limit-0.01,'bill_no',v_order.bill_no,'order_id',v_order.id,
   'bill_amount',v_order.total_amount,'allowed_amount',v_limit,'allocated_amount',v_allocated,
   'remaining_amount',greatest(v_limit-v_allocated,0));
END $$;

ALTER FUNCTION public.bank_overpayment_refunds(uuid) RENAME TO bank_overpayment_refunds_before_waiver;
REVOKE ALL ON FUNCTION public.bank_overpayment_refunds_before_waiver(uuid) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.bank_overpayment_refunds(p_order_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_info jsonb; v_waived numeric;
BEGIN
 v_info:=public.bank_overpayment_refunds_before_waiver(p_order_id);
 v_waived:=public.or_approved_waiver_amount(p_order_id);
 RETURN v_info||jsonb_build_object('waived_amount',v_waived,
   'remaining',greatest(0,(v_info->>'remaining')::numeric-v_waived));
END $$;
REVOKE ALL ON FUNCTION public.bank_overpayment_refunds(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.bank_overpayment_refunds(uuid) TO authenticated;

ALTER FUNCTION public.bank_auto_match_overpayment_refunds(uuid[]) RENAME TO bank_auto_match_overpayment_refunds_before_waiver;
REVOKE ALL ON FUNCTION public.bank_auto_match_overpayment_refunds_before_waiver(uuid[]) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.bank_auto_match_overpayment_refunds(p_order_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_info jsonb; v_waivers jsonb;
BEGIN
 v_info:=public.bank_auto_match_overpayment_refunds_before_waiver(p_order_ids);
 SELECT coalesce(jsonb_object_agg(id::text,public.or_approved_waiver_amount(id)),'{}'::jsonb)
   INTO v_waivers FROM or_orders WHERE id=ANY(p_order_ids);
 RETURN v_info||jsonb_build_object('waived_amounts',v_waivers);
END $$;
REVOKE ALL ON FUNCTION public.bank_auto_match_overpayment_refunds(uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.bank_auto_match_overpayment_refunds(uuid[]) TO authenticated;

-- Expose read-only decisions to sales as well as accounting, under order RLS.
-- This also gives rejected requests a path back to the sales correction queue.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.ac_overpayment_waivers;
  END IF;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
