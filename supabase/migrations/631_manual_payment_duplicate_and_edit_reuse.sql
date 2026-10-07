-- Requires migrations 629 and 630. No automatic financial or slip backfill.
BEGIN;
ALTER TABLE public.ac_manual_slip_checks
 ADD COLUMN duplicate_of uuid REFERENCES public.ac_manual_slip_checks(id),
 ADD COLUMN approved_order_total numeric(12,2);

-- Serialize same-bill submissions/approvals, including direct table writes.
CREATE OR REPLACE FUNCTION public.guard_manual_payment_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_total numeric; v_duplicate uuid;
BEGIN
 SELECT total_amount INTO v_total FROM public.or_orders WHERE id=NEW.order_id FOR UPDATE;
 IF NEW.status IN ('pending','approved') THEN
  IF NEW.duplicate_of IS NOT NULL THEN RAISE EXCEPTION 'รายการซ้ำไม่สามารถนับยอดหรืออนุมัติได้'; END IF;
  SELECT id INTO v_duplicate FROM public.ac_manual_slip_checks
   WHERE order_id=NEW.order_id AND id<>NEW.id AND status IN ('pending','approved')
    AND duplicate_of IS NULL AND trim(transfer_date)=trim(NEW.transfer_date)
    AND trim(transfer_time)=trim(NEW.transfer_time) AND transfer_amount=NEW.transfer_amount
   LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'บิลนี้มีรายการยอดและวันเวลาเดียวกันแล้ว (%) ห้ามส่งหรืออนุมัติซ้ำ',v_duplicate; END IF;
 END IF;
 IF NEW.status='approved' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'approved') THEN
  NEW.approved_order_total:=v_total;
 ELSIF TG_OP='UPDATE' THEN
  IF NOT (OLD.approved_order_total IS NULL AND NEW.approved_order_total=v_total) THEN
   NEW.approved_order_total:=OLD.approved_order_total;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_manual_payment_identity BEFORE INSERT OR UPDATE ON public.ac_manual_slip_checks
 FOR EACH ROW EXECUTE FUNCTION public.guard_manual_payment_identity();

-- A corrected order with the same payable total retains its manual payment proof.
-- No reuse for changed totals, unknown historic approval totals, or pending requests.
CREATE OR REPLACE FUNCTION public.reuse_manual_payment_after_order_edit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_paid numeric; v_owner text;
BEGIN
 IF OLD.status NOT IN ('ลงข้อมูลผิด','รอลงข้อมูล','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ')
  OR NEW.status<>'ลงข้อมูลเสร็จสิ้น' OR NEW.work_order_id IS NOT NULL
  OR NEW.channel_code IS DISTINCT FROM OLD.channel_code
  OR NEW.payment_method IS DISTINCT FROM OLD.payment_method THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.ac_manual_slip_checks WHERE order_id=NEW.id AND status='pending') THEN RETURN NEW; END IF;
 SELECT sum(transfer_amount) INTO v_paid FROM public.ac_manual_slip_checks
 WHERE order_id=NEW.id AND status='approved' AND duplicate_of IS NULL
 AND approved_order_total=NEW.total_amount;
 v_paid:=coalesce(v_paid,0)-coalesce((SELECT sum(amount) FROM public.ac_refunds
  WHERE order_id=NEW.id AND status IN ('pending','approved')),0);
 IF coalesce(v_paid,0)<NEW.total_amount OR NEW.total_amount<=0 THEN RETURN NEW; END IF;
 SELECT role INTO v_owner FROM public.us_users
 WHERE username=NEW.admin_user OR email=NEW.admin_user
 ORDER BY (username=NEW.admin_user) DESC NULLS LAST LIMIT 1;
 NEW.status:=CASE
  WHEN upper(trim(NEW.channel_code))='WY' THEN 'ตรวจสอบแล้ว'
  WHEN v_owner='sales-tr' AND ((NEW.channel_code='PUMP' AND NEW.requires_confirm_design=FALSE)
   OR (NEW.channel_code IS DISTINCT FROM 'PUMP' AND coalesce(NEW.requires_confirm_design,FALSE)=FALSE)) THEN 'รอตรวจคำสั่งซื้อ'
  WHEN NEW.channel_code='PUMP' AND NEW.requires_confirm_design=FALSE THEN 'ไม่ต้องออกแบบ'
  ELSE 'ตรวจสอบแล้ว' END;
 RETURN NEW;
END $$;
CREATE TRIGGER zzy_reuse_manual_payment_after_edit BEFORE UPDATE ON public.or_orders
 FOR EACH ROW EXECUTE FUNCTION public.reuse_manual_payment_after_order_edit();

CREATE OR REPLACE FUNCTION public.or_guard_pickup_shipping()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE pending boolean; controlled boolean:=coalesce(current_setting('app.shipping_conversion_write',true),'')='yes';
BEGIN
 IF TG_OP='UPDATE' THEN
 SELECT EXISTS(SELECT 1 FROM public.or_shipping_conversion_requests WHERE order_id=OLD.id AND status='pending') INTO pending;
 IF NOT controlled AND pending AND (NEW.fulfillment_method IS DISTINCT FROM OLD.fulfillment_method OR NEW.shipping_cost IS DISTINCT FROM OLD.shipping_cost OR NEW.total_amount IS DISTINCT FROM OLD.total_amount OR NEW.price IS DISTINCT FROM OLD.price OR NEW.discount IS DISTINCT FROM OLD.discount OR NEW.channel_code IS DISTINCT FROM OLD.channel_code OR NEW.payment_method IS DISTINCT FROM OLD.payment_method OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('รอออกแบบ','ไม่ต้องออกแบบ','ออกแบบแล้ว','รอคอนเฟิร์ม','คอนเฟิร์มแล้ว','ใบสั่งงาน','ย้ายจากใบงาน','ใบงานกำลังผลิต')) OR NEW.shipped_time IS DISTINCT FROM OLD.shipped_time OR NEW.packing_meta IS DISTINCT FROM OLD.packing_meta OR NEW.transport_meta IS DISTINCT FROM OLD.transport_meta) THEN
 RAISE EXCEPTION 'รอฝ่ายขายจัดการจัดส่ง/ตรวจค่าส่ง/อนุมัติค่าส่ง 0 ก่อนแพ็ค'; END IF;
 IF NOT controlled AND NEW.fulfillment_method IS DISTINCT FROM OLD.fulfillment_method AND NOT EXISTS(SELECT 1 FROM public.us_users WHERE id=auth.uid() AND role IN ('superadmin','admin','sales-tr','sales-pump')) THEN RAISE EXCEPTION 'ฝ่ายขายเท่านั้นที่เปลี่ยนวิธีรับสินค้าได้'; END IF;
 IF NOT controlled AND OLD.fulfillment_method='self_pickup' AND NEW.fulfillment_method='shipping' THEN RAISE EXCEPTION 'ต้องเปลี่ยนผ่านคำขอฝ่ายขายและตรวจเงินก่อน'; END IF;
 IF ((NEW.status='จัดส่งแล้ว' AND OLD.status IS DISTINCT FROM NEW.status) OR (NEW.shipped_time IS NOT NULL AND NEW.shipped_time IS DISTINCT FROM OLD.shipped_time)) AND EXISTS(SELECT 1 FROM public.or_shipping_conversion_requests q WHERE q.order_id=OLD.id AND q.status='ready' AND public.or_shipping_verified_balance(q.id)<q.original_total+q.shipping_cost) THEN RAISE EXCEPTION 'ยอดชำระเปลี่ยนไป ต้องให้บัญชีตรวจสอบก่อนจัดส่ง'; END IF;
 IF NOT controlled AND EXISTS(SELECT 1 FROM public.or_shipping_conversion_requests WHERE order_id=OLD.id AND status='ready') AND
 (NEW.fulfillment_method IS DISTINCT FROM OLD.fulfillment_method OR NEW.shipping_cost IS DISTINCT FROM OLD.shipping_cost OR NEW.total_amount IS DISTINCT FROM OLD.total_amount OR NEW.price IS DISTINCT FROM OLD.price OR NEW.discount IS DISTINCT FROM OLD.discount OR NEW.payment_method IS DISTINCT FROM OLD.payment_method) THEN RAISE EXCEPTION 'ยอดที่ตรวจเงินแล้วต้องแก้ผ่านกระบวนการบัญชี'; END IF;
 END IF;
 NEW.shipping_conversion_pending:=EXISTS(SELECT 1 FROM public.or_shipping_conversion_requests WHERE order_id=NEW.id AND status='pending');
 IF NEW.fulfillment_method='self_pickup' THEN
 IF TG_OP='UPDATE' AND OLD.fulfillment_method='self_pickup' AND coalesce(OLD.shipping_cost,0)<>0 THEN
 -- Historical bills may already offset shipping with a discount. Preserve the
 -- financial snapshot on packing/status/address updates instead of deducting again.
 IF coalesce(current_setting('app.legacy_pickup_normalization',true),'')<>'yes' AND (NEW.price IS DISTINCT FROM OLD.price OR NEW.shipping_cost IS DISTINCT FROM OLD.shipping_cost
    OR NEW.discount IS DISTINCT FROM OLD.discount OR NEW.total_amount IS DISTINCT FROM OLD.total_amount) THEN
   RAISE EXCEPTION 'บิลรับเองเดิมมีค่าส่ง/ส่วนลดชดเชย ห้ามเปลี่ยนยอดอัตโนมัติ ต้องให้บัญชีตรวจสอบก่อน';
 END IF;
 ELSE
 NEW.total_amount:=greatest(0,coalesce(NEW.total_amount,0)-coalesce(NEW.shipping_cost,0));
 NEW.shipping_cost:=0;
 END IF;
 NEW.customer_address:=''; NEW.tracking_number:=NULL;
 NEW.billing_details:=coalesce(NEW.billing_details,'{}'::jsonb)-ARRAY['address_line','sub_district','district','province','postal_code','mobile_phone','original_customer_address'];
 END IF;
 RETURN NEW;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
