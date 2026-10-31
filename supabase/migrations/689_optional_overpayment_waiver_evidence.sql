BEGIN;

-- Keep existing evidence; requests without a link store NULL.
ALTER TABLE public.ac_overpayment_waivers ALTER COLUMN evidence_url DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.submit_overpayment_waiver(p_order_id uuid,p_reason text,p_evidence_url text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_order public.or_orders; v_user public.us_users; v_paid numeric; v_amount numeric; v_id uuid; v_owner_role text; v_next text;
BEGIN
  SELECT * INTO v_user FROM us_users WHERE id=auth.uid();
  IF v_user.role IS NULL OR v_user.role NOT IN ('superadmin','admin','admin-tr','account','order_staff','sales-tr','sales-pump') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ส่งคำขอไม่รับเงินคืน';
  END IF;
  IF nullif(trim(p_reason),'') IS NULL OR length(p_reason)>1000 THEN
    RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ลูกค้าไม่รับเงินคืน (ไม่เกิน 1,000 ตัวอักษร)';
  END IF;
  IF nullif(trim(p_evidence_url),'') IS NOT NULL
    AND trim(p_evidence_url) !~ '^https?://[^[:space:]]+$' THEN
    RAISE EXCEPTION 'กรุณากรอกลิงก์หลักฐานให้ถูกต้อง โดยขึ้นต้นด้วย https:// หรือ http://';
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
    VALUES(p_order_id,v_amount,v_order.total_amount,v_paid,trim(p_reason),nullif(trim(p_evidence_url),''),auth.uid(),coalesce(v_user.username,v_user.email,v_user.id::text)) RETURNING id INTO v_id;
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

NOTIFY pgrst,'reload schema';
COMMIT;
