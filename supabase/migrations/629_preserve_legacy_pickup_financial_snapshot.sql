-- Follow-up for deployed migration 628. No UPDATE of existing rows.
-- Prevent double deduction on historical pickup bills whose shipping was
-- compensated by a discount. Monetary corrections require explicit accounting review.
BEGIN;
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
 IF NEW.price IS DISTINCT FROM OLD.price OR NEW.shipping_cost IS DISTINCT FROM OLD.shipping_cost
    OR NEW.discount IS DISTINCT FROM OLD.discount OR NEW.total_amount IS DISTINCT FROM OLD.total_amount THEN
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
