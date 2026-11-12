-- Manual approval is authoritative for failed EasySlip evidence. Passed receipts remain independent.
BEGIN;
CREATE OR REPLACE FUNCTION public.or_overpayment_paid(p_order_id uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH manual AS (
   SELECT * FROM ac_manual_slip_checks WHERE order_id=p_order_id AND status='approved' AND duplicate_of IS NULL
 ), verified AS (
   SELECT * FROM ac_verified_slips WHERE order_id=p_order_id AND NOT coalesce(is_deleted,false)
     AND (validation_status='passed' OR NOT EXISTS(SELECT 1 FROM manual))
 )
 SELECT coalesce((SELECT sum(verified_amount) FROM verified),0)
 +coalesce((SELECT sum(m.transfer_amount) FROM manual m WHERE NOT EXISTS(
   SELECT 1 FROM verified s WHERE s.verified_amount=m.transfer_amount AND s.easyslip_date IS NOT NULL
    AND to_char(s.easyslip_date AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD')=trim(m.transfer_date)
    AND to_char(s.easyslip_date AT TIME ZONE 'Asia/Bangkok','HH24:MI')=trim(m.transfer_time))),0)
$$;
CREATE FUNCTION public.manual_slip_overpayment(p_order_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.or_orders; paid numeric; remaining numeric;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM us_users WHERE id=auth.uid() AND role IN ('superadmin','admin','account')) THEN
  RAISE EXCEPTION 'ไม่มีสิทธิ์จัดการยอดเกิน'; END IF;
 SELECT * INTO o FROM or_orders WHERE id=p_order_id;
 IF NOT FOUND OR o.status='ยกเลิก' THEN RAISE EXCEPTION 'ไม่พบบิลที่จัดการได้'; END IF;
 paid:=or_overpayment_paid(o.id);
 remaining:=greatest(0,paid-o.receivable_amount-or_approved_overpayment_amount(o.id));
 RETURN jsonb_build_object('order_amount',o.receivable_amount,'paid_amount',paid,'amount',remaining,
  'pending',EXISTS(SELECT 1 FROM ac_refunds WHERE order_id=o.id AND status='pending')
   OR EXISTS(SELECT 1 FROM ac_overpayment_waivers WHERE order_id=o.id AND status='pending'));
END $$;
REVOKE ALL ON FUNCTION public.manual_slip_overpayment(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.manual_slip_overpayment(uuid) TO authenticated;
CREATE OR REPLACE FUNCTION public.manual_slip_decide(p_order_id uuid, p_action text, p_rejected_reason text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE
  v_order public.or_orders;
  v_actor TEXT;
  v_role TEXT;
  v_owner_role TEXT;
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

  SELECT u.role INTO v_owner_role
  FROM public.us_users u
  WHERE u.username = v_order.admin_user OR u.email = v_order.admin_user
  ORDER BY (u.username = v_order.admin_user) DESC NULLS LAST
  LIMIT 1;

  v_new_order_status := CASE
    WHEN p_action = 'rejected' THEN 'ตรวจสอบไม่ผ่าน'
    WHEN upper(trim(v_order.channel_code)) = 'WY' THEN 'ตรวจสอบแล้ว'
    WHEN v_owner_role = 'sales-tr' AND (
      (v_order.channel_code = 'PUMP' AND v_order.requires_confirm_design = FALSE)
      OR (v_order.channel_code IS DISTINCT FROM 'PUMP' AND COALESCE(v_order.requires_confirm_design, FALSE) = FALSE)
    ) THEN 'รอตรวจคำสั่งซื้อ'
    WHEN v_order.channel_code = 'PUMP' AND v_order.requires_confirm_design = FALSE THEN 'ไม่ต้องออกแบบ'
    ELSE 'ตรวจสอบแล้ว'
  END;
  UPDATE public.or_orders SET status = v_new_order_status WHERE id = p_order_id;

  RETURN jsonb_build_object('updated_count', v_count, 'order_status', v_new_order_status, 'overpayment', public.manual_slip_overpayment(p_order_id));
END;
$_$;
CREATE FUNCTION public.manual_slip_request_refund(p_order_id uuid,p_details jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.or_orders; info jsonb;
BEGIN
 SELECT * INTO o FROM or_orders WHERE id=p_order_id FOR UPDATE;
 info:=manual_slip_overpayment(p_order_id);
 IF NOT EXISTS(SELECT 1 FROM ac_manual_slip_checks WHERE order_id=p_order_id AND status='approved' AND duplicate_of IS NULL) THEN
  RAISE EXCEPTION 'ต้องอนุมัติสลิปมือก่อน'; END IF;
 IF (info->>'pending')::boolean THEN RAISE EXCEPTION 'มีคำขอจัดการยอดเกินรอพิจารณาแล้ว'; END IF;
 IF (info->>'amount')::numeric<=0.01 THEN RAISE EXCEPTION 'ไม่พบยอดโอนเกินที่ต้องจัดการ'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text('["refund_recipient_account_name","refund_recipient_bank","refund_recipient_account_number","refund_recipient_reason"]'::jsonb) k WHERE nullif(trim(p_details->>k),'') IS NULL) THEN
  RAISE EXCEPTION 'กรุณากรอกข้อมูลบัญชีและเหตุผลให้ครบ'; END IF;
 IF nullif(trim(p_details->>'refund_request_link'),'') IS NOT NULL AND (p_details->>'refund_request_link') !~ '^https?://[^[:space:]]+$' THEN RAISE EXCEPTION 'ลิงก์ไม่ถูกต้อง'; END IF;
 INSERT INTO ac_refunds(order_id,amount,reason,status,refund_recipient_account_name,refund_recipient_bank,refund_recipient_account_number,refund_recipient_reason,refund_request_link)
 VALUES(p_order_id,(info->>'amount')::numeric,'โอนเกิน (ตรวจสลิปมือ)','pending',trim(p_details->>'refund_recipient_account_name'),trim(p_details->>'refund_recipient_bank'),trim(p_details->>'refund_recipient_account_number'),trim(p_details->>'refund_recipient_reason'),nullif(trim(p_details->>'refund_request_link'),''));
END $$;
REVOKE ALL ON FUNCTION public.manual_slip_request_refund(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.manual_slip_request_refund(uuid,jsonb) TO authenticated;
COMMIT;
