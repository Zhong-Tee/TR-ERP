-- Resolve overpayment before entering production. Keep financial actions from
-- rewinding an existing production/shipping lifecycle. No bulk order backfill.
BEGIN;

CREATE TABLE public.or_order_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.or_orders(id) ON DELETE CASCADE,
  bill_no text NOT NULL,
  previous_status text,
  requested_status text NOT NULL,
  resulting_status text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('changed','preserved')),
  actor_id uuid,
  actor_name text NOT NULL,
  source text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX or_order_status_history_order_time
  ON public.or_order_status_history(order_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS ac_refunds_order_created_id
  ON public.ac_refunds(order_id,created_at DESC,id DESC);
ALTER TABLE public.or_order_status_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read status history of accessible orders" ON public.or_order_status_history
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.or_orders o WHERE o.id=order_id
  ));
REVOKE ALL ON public.or_order_status_history FROM anon,authenticated;
GRANT SELECT ON public.or_order_status_history TO authenticated;

-- Same authoritative slip amounts used by the order form. Over-amount slips
-- may have validation_status=failed solely because the amount exceeds the bill.
CREATE FUNCTION public.or_refund_production_block(p_order_id uuid,p_total numeric)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_latest record; v_paid numeric; v_approved numeric;
BEGIN
  SELECT status,rejected_reason INTO v_latest FROM public.ac_refunds
  WHERE order_id=p_order_id ORDER BY created_at DESC,id DESC LIMIT 1;
  IF EXISTS(SELECT 1 FROM public.ac_refunds WHERE order_id=p_order_id AND status='pending') THEN
    RETURN 'รออนุมัติคำขอโอนคืน';
  END IF;
  IF v_latest.status='rejected' THEN
    RETURN 'คำขอโอนคืนถูกปฏิเสธ: '||coalesce(nullif(trim(v_latest.rejected_reason),''),'กรุณาแก้ไขและส่งคำขอใหม่');
  END IF;
  SELECT coalesce(sum(verified_amount),0) INTO v_paid FROM public.ac_verified_slips
  WHERE order_id=p_order_id AND NOT coalesce(is_deleted,false);
  SELECT coalesce(sum(amount),0) INTO v_approved FROM public.ac_refunds
  WHERE order_id=p_order_id AND status='approved' AND reason ILIKE '%โอนเกิน%';
  IF v_paid-coalesce(p_total,0)-v_approved>0.01 THEN
    RETURN 'พบยอดโอนเกิน '||to_char(v_paid-coalesce(p_total,0)-v_approved,'FM999999999990.00')||' บาท ยังไม่มีคำขอโอนคืนที่อนุมัติครอบคลุมยอด';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.or_refund_production_block(uuid,numeric) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.or_work_order_refund_blocks(p_order_ids uuid[])
RETURNS TABLE(order_id uuid,bill_no text,reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.us_users WHERE id=auth.uid()
    AND role IN ('superadmin','admin','admin-tr','order_staff','packing_staff','manager','production','sales-tr','sales-pump')) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ตรวจเงื่อนไขเข้าใบงาน';
  END IF;
  RETURN QUERY SELECT o.id,o.bill_no,b.reason FROM public.or_orders o
  CROSS JOIN LATERAL (SELECT public.or_refund_production_block(o.id,o.total_amount) AS reason) b
  WHERE o.id=ANY(p_order_ids) AND b.reason IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION public.or_work_order_refund_blocks(uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.or_work_order_refund_blocks(uuid[]) TO authenticated;

-- Every refund/slip mutation takes the same parent lock as work-order creation.
-- Thus approval/submission and production admission cannot pass stale checks.
CREATE FUNCTION public.or_lock_payment_order()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_ids uuid[];
BEGIN
  IF TG_OP='INSERT' THEN v_ids:=ARRAY[NEW.order_id];
  ELSIF TG_OP='DELETE' THEN v_ids:=ARRAY[OLD.order_id];
  ELSE v_ids:=ARRAY[OLD.order_id,NEW.order_id]; END IF;
  PERFORM 1 FROM public.or_orders WHERE id=ANY(v_ids) ORDER BY id FOR UPDATE;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER aa_refund_lock_order BEFORE INSERT OR UPDATE OR DELETE ON public.ac_refunds
  FOR EACH ROW EXECUTE FUNCTION public.or_lock_payment_order();
CREATE TRIGGER aa_verified_slip_lock_order BEFORE INSERT OR UPDATE OR DELETE ON public.ac_verified_slips
  FOR EACH ROW EXECUTE FUNCTION public.or_lock_payment_order();

CREATE FUNCTION public.or_guard_refund_production_and_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_reason text; v_requested text; v_actor text;
BEGIN
  -- Gate every attachment path, including direct updates and legacy name-only links.
  IF (NEW.work_order_id IS NOT NULL OR nullif(trim(NEW.work_order_name),'') IS NOT NULL)
    AND (TG_OP='INSERT' OR NEW.work_order_id IS DISTINCT FROM OLD.work_order_id
      OR NEW.work_order_name IS DISTINCT FROM OLD.work_order_name) THEN
    v_reason:=public.or_refund_production_block(NEW.id,NEW.total_amount);
    IF v_reason IS NOT NULL THEN
      RAISE EXCEPTION 'บิล % เข้าใบงานไม่ได้: %',NEW.bill_no,v_reason;
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    v_requested:=NEW.status;
    -- An explicit packing reset clears shipped_time; cancellation remains allowed.
    IF OLD.status='จัดส่งแล้ว' AND OLD.shipped_time IS NOT NULL
      AND NEW.shipped_time IS NOT NULL AND NEW.status<>'ยกเลิก' THEN
      NEW.status:=OLD.status;
    ELSIF (OLD.work_order_id IS NOT NULL OR nullif(trim(OLD.work_order_name),'') IS NOT NULL)
      AND NEW.work_order_id IS NOT DISTINCT FROM OLD.work_order_id
      AND NEW.work_order_name IS NOT DISTINCT FROM OLD.work_order_name
      AND OLD.status<>'ยกเลิก'
      AND NEW.status IN ('รอลงข้อมูล','ลงข้อมูลเสร็จสิ้น','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน',
        'ตรวจสอบไม่สำเร็จ','รอตรวจคำสั่งซื้อ','ตรวจสอบแล้ว','รอออกแบบ','ไม่ต้องออกแบบ',
        'ออกแบบแล้ว','รอคอนเฟิร์ม','คอนเฟิร์มแล้ว','เสร็จสิ้น','ใบสั่งงาน') THEN
      NEW.status:=OLD.status;
    END IF;
    IF NEW.status IS DISTINCT FROM v_requested THEN
      SELECT coalesce(username,email) INTO v_actor FROM public.us_users WHERE id=auth.uid();
      INSERT INTO public.or_order_status_history(order_id,bill_no,previous_status,requested_status,
        resulting_status,event_type,actor_id,actor_name,source,reason)
      VALUES(OLD.id,OLD.bill_no,OLD.status,v_requested,NEW.status,'preserved',auth.uid(),
        coalesce(v_actor,current_user),coalesce(nullif(current_setting('app.order_status_source',true),''),'order_update'),
        'คงสถานะงานผลิต/ขนส่งไว้ ป้องกันการย้อนกลับจากขั้นตอนตรวจข้อมูลหรือการเงิน');
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- Runs after the older payment-routing/terminal guards.
CREATE TRIGGER zzzz_refund_production_status_guard BEFORE INSERT OR UPDATE ON public.or_orders
  FOR EACH ROW EXECUTE FUNCTION public.or_guard_refund_production_and_status();

CREATE FUNCTION public.or_audit_status_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_actor text;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT coalesce(username,email) INTO v_actor FROM public.us_users WHERE id=auth.uid();
    INSERT INTO public.or_order_status_history(order_id,bill_no,previous_status,requested_status,
      resulting_status,event_type,actor_id,actor_name,source,reason)
    VALUES(NEW.id,NEW.bill_no,OLD.status,NEW.status,NEW.status,'changed',auth.uid(),
      coalesce(v_actor,current_user),coalesce(nullif(current_setting('app.order_status_source',true),''),'order_update'),
      nullif(current_setting('app.order_status_reason',true),''));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zzzz_audit_order_status AFTER UPDATE ON public.or_orders
  FOR EACH ROW EXECUTE FUNCTION public.or_audit_status_change();
REVOKE ALL ON FUNCTION public.or_lock_payment_order(),public.or_guard_refund_production_and_status(),public.or_audit_status_change() FROM PUBLIC,anon,authenticated;

-- Invoker permissions retain the existing order RLS; the trigger is still the
-- authority if an older client writes status directly.
CREATE FUNCTION public.or_apply_payment_review_status(p_order_id uuid,p_status text,p_source text)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE v_status text;
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('easyslip','overpayment_request','order_review') THEN
    RAISE EXCEPTION 'ไม่รู้จักขั้นตอนเปลี่ยนสถานะ';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ','ตรวจสอบแล้ว','รอตรวจคำสั่งซื้อ',
    'ไม่ต้องออกแบบ','รอคอนเฟิร์ม','ใบสั่งงาน','ลงข้อมูลผิด') THEN
    RAISE EXCEPTION 'สถานะไม่ใช่ขั้นตอนตรวจข้อมูล/ชำระเงิน';
  END IF;
  PERFORM set_config('app.order_status_source',p_source,true);
  UPDATE public.or_orders SET status=p_status WHERE id=p_order_id RETURNING status INTO v_status;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบบิลหรือไม่มีสิทธิ์แก้ไข'; END IF;
  RETURN v_status;
END $$;
REVOKE ALL ON FUNCTION public.or_apply_payment_review_status(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.or_apply_payment_review_status(uuid,text,text) TO authenticated;
COMMIT;
