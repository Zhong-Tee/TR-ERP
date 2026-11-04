-- Web import (607) is optional on some installations. Read its snapshot through
-- JSON so direct sales remain protected even when the column is absent.
-- ->> treats both a missing field and SQL NULL as NULL.
BEGIN;

CREATE OR REPLACE FUNCTION public.or_guard_sales_discount() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE state_ jsonb; role_ text; commercial_change boolean:=false;
BEGIN
 IF (TG_OP='INSERT' AND NEW.source_prebill_document_id IS NOT NULL) OR
  (TG_OP='UPDATE' AND NEW.source_prebill_document_id IS DISTINCT FROM OLD.source_prebill_document_id) THEN
  IF NEW.source_prebill_document_id IS NULL OR coalesce(current_setting('app.discount_prebill_conversion',true),'')<>NEW.source_prebill_document_id::text THEN
   RAISE EXCEPTION 'เอกสาร QT/PC ต้องเชื่อมผ่านขั้นตอนเปิดบิลเท่านั้น';
  END IF;
 END IF;
 IF TG_OP='INSERT' THEN NEW.automatic_discount_snapshot:=NULL; NEW.discount_approval_enabled:=true;
 ELSE
  NEW.automatic_discount_snapshot:=OLD.automatic_discount_snapshot;
  commercial_change:=public.or_discount_snapshot(to_jsonb(NEW),'[]')<>public.or_discount_snapshot(to_jsonb(OLD),'[]');
  NEW.discount_approval_enabled:=OLD.discount_approval_enabled OR NEW.discount_approval_enabled OR commercial_change;
 END IF;
 NEW.payment_not_required:=false;
 IF NEW.discount_approval_enabled AND NEW.source_marketplace_order_id IS NULL AND (to_jsonb(NEW)->>'web_import_snapshot') IS NULL AND upper(coalesce(NEW.bill_no,'')) NOT LIKE 'REQ%' THEN
  IF NEW.total_amount IS NULL OR NEW.price IS NULL OR NEW.discount IS NULL OR NEW.shipping_cost IS NULL THEN RAISE EXCEPTION 'กรุณาระบุยอดสินค้า ค่าส่ง ส่วนลด และยอดสุทธิ'; END IF;
  IF NEW.total_amount<0 OR NEW.discount<0 THEN RAISE EXCEPTION 'ยอดสุทธิและส่วนลดต้องไม่ติดลบ'; END IF;
  state_:=public.or_discount_state(NEW.id,to_jsonb(NEW),public.or_discount_items(NEW.id),
    coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM public.or_order_promotions p WHERE order_id=NEW.id),'[]'));
  NEW.payment_not_required:=coalesce((state_->>'zero_payment')::boolean,false);
  IF NEW.discount>0 AND NOT (state_->>'required')::boolean AND NEW.status NOT IN ('รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ','ยกเลิก') THEN
   NEW.automatic_discount_snapshot:=public.or_discount_snapshot(to_jsonb(NEW),public.or_discount_items(NEW.id));
  END IF;

  IF NEW.payment_not_required AND NEW.status='ลงข้อมูลเสร็จสิ้น' THEN
   SELECT role INTO role_ FROM public.us_users WHERE NEW.admin_user IN(username,email) ORDER BY (username=NEW.admin_user) DESC NULLS LAST LIMIT 1;
   NEW.status:=CASE WHEN upper(NEW.channel_code)='WY' THEN 'ตรวจสอบแล้ว'
    WHEN role_='sales-tr' AND ((NEW.channel_code='PUMP' AND NEW.requires_confirm_design=false) OR (NEW.channel_code<>'PUMP' AND NOT coalesce(NEW.requires_confirm_design,false))) THEN 'รอตรวจคำสั่งซื้อ'
    WHEN NEW.channel_code='PUMP' AND NEW.requires_confirm_design=false THEN 'ไม่ต้องออกแบบ' ELSE 'ตรวจสอบแล้ว' END;
  END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.or_validate_sales_discount() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.or_orders; id_ uuid; state_ jsonb;
BEGIN
 id_:=CASE WHEN TG_TABLE_NAME='or_orders' THEN (to_jsonb(NEW)->>'id')::uuid ELSE coalesce((to_jsonb(NEW)->>'order_id')::uuid,(to_jsonb(OLD)->>'order_id')::uuid) END;
 SELECT * INTO o FROM public.or_orders WHERE id=id_ FOR UPDATE;
 IF o.id IS NULL OR NOT o.discount_approval_enabled OR o.source_marketplace_order_id IS NOT NULL OR (to_jsonb(o)->>'web_import_snapshot') IS NOT NULL OR upper(coalesce(o.bill_no,'')) LIKE 'REQ%' THEN RETURN NULL; END IF;
 state_:=public.or_discount_state(o.id,to_jsonb(o),public.or_discount_items(o.id),coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM public.or_order_promotions p WHERE order_id=o.id),'[]'));
 UPDATE public.or_sales_discount_requests SET status=CASE WHEN o.status='ยกเลิก' THEN 'cancelled' ELSE 'stale' END
 WHERE order_id=o.id AND status IN ('pending','approved') AND (o.status='ยกเลิก' OR snapshot<>public.or_discount_snapshot(to_jsonb(o),public.or_discount_items(o.id)));
 IF o.status='ยกเลิก' THEN state_:=state_||jsonb_build_object('approved',false,'zero_payment',false); END IF;
 IF o.payment_not_required IS DISTINCT FROM coalesce((state_->>'zero_payment')::boolean,false) THEN
  UPDATE public.or_orders SET payment_not_required=coalesce((state_->>'zero_payment')::boolean,false) WHERE id=o.id;
 END IF;
 IF o.status NOT IN ('รอลงข้อมูล','ลงข้อมูลผิด','ตรวจสอบไม่ผ่าน','ตรวจสอบไม่สำเร็จ','ยกเลิก') THEN
  IF o.total_amount IS NULL OR o.price IS NULL OR o.shipping_cost IS NULL OR o.discount IS NULL OR o.total_amount<>round(o.price+o.shipping_cost-o.discount,2) OR o.total_amount<0 THEN RAISE EXCEPTION 'ยอดสุทธิไม่ตรงกับสินค้า ค่าส่ง และส่วนลด'; END IF;
  IF (state_->>'required')::boolean AND NOT (state_->>'approved')::boolean THEN RAISE EXCEPTION 'ส่วนลดต้องได้รับอนุมัติจาก superadmin และตรงกับรายการปัจจุบันก่อนยืนยันบิล'; END IF;
 END IF;
 RETURN NULL;
END $$;

COMMIT;
