-- Sales-owned pickup-to-shipping requests. Rollout order:
-- 1. Run scripts/audit_pickup_shipping.sql and resolve historical anomalies.
-- 2. Apply this migration, then deploy verify-shipping-conversion (uses existing verify-slip).
-- 3. Deploy the frontend. Existing production/QC progress and product scans are preserved.
BEGIN;
ALTER TABLE public.or_orders ADD COLUMN shipping_conversion_pending boolean NOT NULL DEFAULT false;
CREATE TABLE public.or_shipping_conversion_requests (
 id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
 order_id uuid NOT NULL REFERENCES public.or_orders(id),
 requested_by uuid NOT NULL REFERENCES auth.users(id),
 requested_at timestamptz NOT NULL DEFAULT now(),
 shipping_cost numeric(10,2) NOT NULL CHECK (shipping_cost >= 0),
 original_total numeric(10,2) NOT NULL,
 suggested_shipping_cost numeric(10,2),
 details jsonb NOT NULL,
 reason text NOT NULL CHECK (length(btrim(reason)) > 0),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','rejected','cancelled')),
 zero_approved_by uuid REFERENCES auth.users(id),
 zero_approved_at timestamptz,
 reviewed_by uuid REFERENCES auth.users(id),
 reviewed_at timestamptz,
 review_reason text,
 completed_at timestamptz,
 verification_error text,
 last_verification_at timestamptz
);
CREATE UNIQUE INDEX or_shipping_conversion_one_active ON public.or_shipping_conversion_requests(order_id) WHERE status IN ('pending','ready');
CREATE TABLE public.or_shipping_conversion_payments (
 id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
 request_id uuid NOT NULL REFERENCES public.or_shipping_conversion_requests(id),
 trans_ref text NOT NULL UNIQUE,
 amount numeric(10,2) NOT NULL CHECK(amount > 0),
 storage_path text NOT NULL,
 response jsonb NOT NULL,
 verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shipping_conversion_order_history ON public.or_shipping_conversion_requests(order_id,requested_at DESC);
CREATE INDEX shipping_conversion_payment_request ON public.or_shipping_conversion_payments(request_id);
ALTER TABLE public.or_shipping_conversion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.or_shipping_conversion_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY shipping_requests_read ON public.or_shipping_conversion_requests FOR SELECT TO authenticated USING (
 EXISTS(SELECT 1 FROM public.us_users WHERE id=auth.uid() AND role IN ('superadmin','admin','account','sales-tr','sales-pump','packing_staff','production'))
 AND EXISTS(SELECT 1 FROM public.or_orders WHERE id=order_id)
);
CREATE POLICY shipping_payments_read ON public.or_shipping_conversion_payments FOR SELECT TO authenticated USING (
 EXISTS(SELECT 1 FROM public.or_shipping_conversion_requests WHERE id=request_id)
);
REVOKE INSERT,UPDATE,DELETE ON public.or_shipping_conversion_requests,public.or_shipping_conversion_payments FROM authenticated,anon;
GRANT SELECT ON public.or_shipping_conversion_requests,public.or_shipping_conversion_payments TO authenticated;
GRANT ALL ON public.or_shipping_conversion_requests,public.or_shipping_conversion_payments TO service_role;

-- Retire the packing-side conversion, including direct RPC callers.
REVOKE EXECUTE ON FUNCTION public.pk_convert_self_pickup_to_shipping(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM authenticated,anon,PUBLIC;

CREATE FUNCTION public.or_shipping_address_key(p_value text,p_kind text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT CASE WHEN p_kind='province' AND v IN ('กรุงเทพฯ','กรุงเทพ','กทม') THEN 'กรุงเทพมหานคร' ELSE v END
 FROM (SELECT lower(regexp_replace(regexp_replace(btrim(coalesce(p_value,'')),
 CASE p_kind WHEN 'province' THEN '^(จังหวัด|จ\.)' WHEN 'district' THEN '^(เขต|อำเภอ|อ\.)' WHEN 'sub_district' THEN '^(แขวง|ตำบล|ต\.)' ELSE '^$' END,''), '[[:space:]._/\-]','','g')) v) n;
$$;
CREATE FUNCTION public.or_quote_conversion_shipping(p_order_id uuid,p_details jsonb)
RETURNS numeric LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE o public.or_orders; base numeric; extra numeric;
BEGIN
 SELECT * INTO o FROM public.or_orders WHERE id=p_order_id;
 IF o.id IS NULL THEN RAISE EXCEPTION 'ไม่พบบิล'; END IF;
 SELECT shipping_fee INTO base FROM public.or_shipping_fee_ranges WHERE o.price >= min_amount AND (max_amount IS NULL OR o.price <= max_amount) ORDER BY sort_order,min_amount LIMIT 1;
 IF EXISTS(SELECT 1 FROM public.or_shipping_fee_settings WHERE id=1 AND special_area_enabled) THEN
 SELECT surcharge INTO extra FROM public.or_shipping_area_rules a WHERE is_active
 AND (is_forever OR (now() AT TIME ZONE 'Asia/Bangkok')::date BETWEEN start_date AND end_date)
 AND (coalesce(cardinality(channel_codes),0)=0 OR o.channel_code=ANY(channel_codes))
 AND regexp_replace(upper(a.carrier),'(EXPRESS|ขนส่ง|[^A-Z0-9ก-๙])','','g')=regexp_replace(upper(p_details->>'carrier'),'(EXPRESS|ขนส่ง|[^A-Z0-9ก-๙])','','g')
 AND (nullif(a.postal_code,'') IS NULL OR a.postal_code=p_details->>'postal_code')
 AND public.or_shipping_address_key(a.province,'province')=public.or_shipping_address_key(p_details->>'province','province')
 AND public.or_shipping_address_key(a.district,'district')=public.or_shipping_address_key(p_details->>'district','district')
 AND (nullif(a.sub_district,'') IS NULL OR public.or_shipping_address_key(a.sub_district,'sub_district')=public.or_shipping_address_key(p_details->>'sub_district','sub_district'))
 ORDER BY (CASE WHEN cardinality(channel_codes)>0 THEN 100 ELSE 0 END+CASE WHEN nullif(a.sub_district,'') IS NOT NULL THEN 40 ELSE 0 END+CASE WHEN nullif(a.district,'') IS NOT NULL THEN 20 ELSE 0 END+CASE WHEN nullif(a.postal_code,'') IS NOT NULL THEN 10 ELSE 0 END+CASE WHEN nullif(a.province,'') IS NOT NULL THEN 5 ELSE 0 END) DESC,surcharge DESC LIMIT 1;
 END IF;
 IF base IS NULL AND extra IS NULL THEN RETURN NULL; END IF;
 RETURN coalesce(base,0)+coalesce(extra,0);
END $$;
REVOKE ALL ON FUNCTION public.or_quote_conversion_shipping(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.or_quote_conversion_shipping(uuid,jsonb) TO authenticated;

CREATE FUNCTION public.or_request_shipping_conversion(p_order_id uuid,p_shipping_cost numeric,p_details jsonb,p_reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE o public.or_orders; r text; result uuid;
BEGIN
 SELECT role INTO r FROM public.us_users WHERE id=auth.uid();
 IF r IS NULL OR r NOT IN ('superadmin','admin','sales-tr','sales-pump') THEN RAISE EXCEPTION 'ฝ่ายขายเท่านั้นที่ขอเปลี่ยนเป็นจัดส่งได้'; END IF;
 SELECT * INTO o FROM public.or_orders WHERE id=p_order_id FOR UPDATE;
 IF r IN ('sales-tr','sales-pump') AND NOT EXISTS(SELECT 1 FROM public.channel_role_visibility WHERE channel_code=o.channel_code AND role=r) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ช่องทางนี้'; END IF;
 IF r='sales-pump' AND NOT EXISTS(SELECT 1 FROM public.us_users WHERE id=auth.uid() AND o.admin_user IN (username,email)) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์จัดการบิลของผู้อื่น'; END IF;
 IF o.id IS NULL OR o.fulfillment_method <> 'self_pickup' OR o.status IN ('ยกเลิก','จัดส่งแล้ว') OR o.shipped_time IS NOT NULL
    OR coalesce((o.transport_meta->>'customer_received')::boolean,false) THEN RAISE EXCEPTION 'บิลนี้ไม่สามารถเปลี่ยนเป็นจัดส่งได้'; END IF;
 IF p_shipping_cost IS NULL OR p_shipping_cost::text='NaN' OR p_shipping_cost < 0 OR p_shipping_cost <> round(p_shipping_cost,2) OR nullif(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'ระบุค่าส่งและเหตุผลให้ถูกต้อง'; END IF;
 IF coalesce(o.shipping_cost,0)<>0 THEN RAISE EXCEPTION 'บิลรับเองมีค่าส่งเดิม ให้บัญชีตรวจสอบก่อนเปลี่ยน'; END IF;
 IF p_details IS NULL OR jsonb_typeof(p_details)<>'object' OR EXISTS (
 SELECT 1 FROM unnest(ARRAY['recipient_name','address_line','sub_district','district','province','postal_code','mobile_phone','carrier']) k WHERE nullif(btrim(p_details->>k),'') IS NULL
 ) OR (p_details->>'postal_code') !~ '^[0-9]{5}$' THEN RAISE EXCEPTION 'กรอกผู้รับ ที่อยู่ ขนส่ง และรหัสไปรษณีย์ให้ครบ'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tr_shipping_carriers WHERE code=p_details->>'carrier' AND is_active AND upper(code)<>'SELF') THEN RAISE EXCEPTION 'เลือกขนส่งที่ใช้งาน'; END IF;
 INSERT INTO public.or_shipping_conversion_requests(order_id,requested_by,shipping_cost,original_total,details,reason,suggested_shipping_cost)
 VALUES(o.id,auth.uid(),p_shipping_cost,o.total_amount,p_details,btrim(p_reason),public.or_quote_conversion_shipping(o.id,p_details)) RETURNING id INTO result;
 UPDATE public.or_orders SET shipping_conversion_pending=true WHERE id=o.id;
 RETURN result;
END $$;

-- Cap old receipts at the original bill total: old overpayments cannot silently
-- pay new shipping, and pending/approved refunds are reserved out of the balance.
CREATE FUNCTION public.or_shipping_verified_balance(p_request_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT least(q.original_total,greatest(0,
 coalesce((SELECT sum(s.amount) FROM (SELECT max(verified_amount) amount FROM public.ac_verified_slips WHERE order_id=q.order_id AND validation_status='passed' AND coalesce(is_deleted,false)=false AND easyslip_trans_ref IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.or_shipping_conversion_payments p WHERE p.trans_ref=ac_verified_slips.easyslip_trans_ref) GROUP BY easyslip_trans_ref) s),0)
 -coalesce((SELECT sum(amount) FROM public.ac_refunds WHERE order_id=q.order_id AND status IN ('pending','approved')),0)))
 +coalesce((SELECT sum(amount) FROM public.or_shipping_conversion_payments WHERE request_id=q.id),0)
 FROM public.or_shipping_conversion_requests q WHERE q.id=p_request_id;
$$;
REVOKE ALL ON FUNCTION public.or_shipping_verified_balance(uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.or_shipping_conversion_balances(p_request_ids uuid[])
RETURNS TABLE(request_id uuid,paid numeric,remaining numeric) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT q.id,b.paid,greatest(0,q.original_total+q.shipping_cost-b.paid)
 FROM public.or_shipping_conversion_requests q
 CROSS JOIN LATERAL (SELECT public.or_shipping_verified_balance(q.id) paid) b
 WHERE q.id=ANY(p_request_ids) AND EXISTS(SELECT 1 FROM public.us_users WHERE id=auth.uid() AND role IN ('superadmin','admin','account','sales-tr','sales-pump'));
$$;
REVOKE ALL ON FUNCTION public.or_shipping_conversion_balances(uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.or_shipping_conversion_balances(uuid[]) TO authenticated;

CREATE FUNCTION public.or_complete_shipping_conversion(p_request_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE q public.or_shipping_conversion_requests; o public.or_orders; paid numeric; actor text;
BEGIN
 SELECT * INTO q FROM public.or_shipping_conversion_requests WHERE id=p_request_id FOR UPDATE;
 IF q.id IS NULL THEN RAISE EXCEPTION 'ไม่พบคำขอ'; END IF;
 IF q.status='ready' THEN RETURN public.or_shipping_verified_balance(q.id)>=q.original_total+q.shipping_cost; END IF;
 IF q.status<>'pending' THEN RETURN false; END IF;
 SELECT * INTO o FROM public.or_orders WHERE id=q.order_id FOR UPDATE;
 IF o.status IN ('ยกเลิก','จัดส่งแล้ว') OR o.shipped_time IS NOT NULL OR o.fulfillment_method<>'self_pickup' THEN RAISE EXCEPTION 'สถานะบิลเปลี่ยนไป กรุณาตรวจสอบ'; END IF;
 IF q.shipping_cost=0 AND q.zero_approved_by IS NULL THEN RETURN false; END IF;
 SELECT public.or_shipping_verified_balance(q.id) INTO paid;
 IF paid < q.original_total+q.shipping_cost THEN RETURN false; END IF;
 SELECT coalesce(username,email,id::text) INTO actor FROM public.us_users WHERE id=q.requested_by;
 PERFORM set_config('app.shipping_conversion_write','yes',true);
 UPDATE public.or_shipping_conversion_requests SET status='ready',completed_at=now(),verification_error=NULL WHERE id=q.id;
 INSERT INTO public.or_fulfillment_change_logs(order_id,bill_no,from_method,to_method,reason,previous_status,previous_customer_address,previous_recipient_name,previous_tracking_number,changed_by,changed_by_user_id)
 VALUES(o.id,o.bill_no,'self_pickup','shipping',q.reason,o.status,o.customer_address,o.recipient_name,o.tracking_number,actor,q.requested_by);
 UPDATE public.or_orders SET fulfillment_method='shipping',shipping_cost=q.shipping_cost,total_amount=q.original_total+q.shipping_cost,
 recipient_name=q.details->>'recipient_name',customer_address=concat_ws(' ',q.details->>'address_line',q.details->>'sub_district',q.details->>'district',q.details->>'province',q.details->>'postal_code'),
 billing_details=coalesce(o.billing_details,'{}'::jsonb)|| (q.details - 'recipient_name' - 'carrier'),
 transport_meta=coalesce(o.transport_meta,'{}'::jsonb)||jsonb_build_object('carrier',q.details->>'carrier'),
 converted_from_self_pickup_at=now(),converted_from_self_pickup_by=actor,tracking_number=NULL,
 packing_meta=coalesce(o.packing_meta,'{}'::jsonb)-'parcelScanned'-'scanTime'
 WHERE id=o.id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.or_complete_shipping_conversion(uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.or_review_zero_shipping(p_request_id uuid,p_approve boolean,p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r text; q public.or_shipping_conversion_requests;
BEGIN
 SELECT role INTO r FROM public.us_users WHERE id=auth.uid();
 IF r IS NULL OR r NOT IN ('superadmin','admin','account') THEN RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติค่าส่ง 0'; END IF;
 SELECT * INTO q FROM public.or_shipping_conversion_requests WHERE id=p_request_id FOR UPDATE;
 IF q.id IS NULL OR q.status<>'pending' OR q.shipping_cost<>0 OR q.zero_approved_by IS NOT NULL THEN RAISE EXCEPTION 'คำขอนี้ไม่อยู่ระหว่างรออนุมัติ'; END IF;
 IF p_approve IS NULL OR nullif(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลการอนุมัติหรือปฏิเสธ'; END IF;
 UPDATE public.or_shipping_conversion_requests SET reviewed_by=auth.uid(),reviewed_at=now(),review_reason=btrim(p_reason),
 zero_approved_by=CASE WHEN p_approve THEN auth.uid() END,zero_approved_at=CASE WHEN p_approve THEN now() END,
 status=CASE WHEN p_approve THEN 'pending' ELSE 'rejected' END WHERE id=q.id;
 IF NOT p_approve THEN UPDATE public.or_orders SET shipping_conversion_pending=false WHERE id=q.order_id; END IF;
 RETURN public.or_complete_shipping_conversion(q.id);
END $$;

CREATE FUNCTION public.or_cancel_shipping_conversion(p_request_id uuid,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r text; q public.or_shipping_conversion_requests;
BEGIN
 SELECT role INTO r FROM public.us_users WHERE id=auth.uid();
 SELECT * INTO q FROM public.or_shipping_conversion_requests WHERE id=p_request_id FOR UPDATE;
 IF r IS NULL OR r NOT IN ('superadmin','admin','sales-tr','sales-pump') OR (r NOT IN ('superadmin','admin') AND q.requested_by<>auth.uid()) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ยกเลิกคำขอ'; END IF;
 IF q.id IS NULL OR q.status<>'pending' OR nullif(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'ระบุเหตุผลสำหรับคำขอที่รอดำเนินการ'; END IF;
 IF EXISTS(SELECT 1 FROM public.or_shipping_conversion_payments WHERE request_id=q.id) THEN RAISE EXCEPTION 'มีค่าส่งชำระแล้ว ให้ฝ่ายบัญชีจัดการเงินก่อนยกเลิก'; END IF;
 UPDATE public.or_shipping_conversion_requests SET status='cancelled',review_reason=p_reason,reviewed_by=auth.uid(),reviewed_at=now() WHERE id=q.id;
 UPDATE public.or_orders SET shipping_conversion_pending=false WHERE id=q.order_id;
END $$;

CREATE FUNCTION public.or_refresh_shipping_conversion(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r text; q public.or_shipping_conversion_requests; paid numeric; ready boolean;
BEGIN
 SELECT role INTO r FROM public.us_users WHERE id=auth.uid();
 SELECT * INTO q FROM public.or_shipping_conversion_requests WHERE id=p_request_id;
 IF r IS NULL OR r NOT IN ('superadmin','admin','account','sales-tr','sales-pump') OR q.id IS NULL
 OR (r IN ('sales-tr','sales-pump') AND q.requested_by<>auth.uid()) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ตรวจยอดคำขอนี้'; END IF;
 ready:=public.or_complete_shipping_conversion(q.id);
 paid:=public.or_shipping_verified_balance(q.id);
 RETURN jsonb_build_object('ready',ready,'paid',paid,'remaining',greatest(0,q.original_total+q.shipping_cost-paid));
END $$;
REVOKE ALL ON FUNCTION public.or_refresh_shipping_conversion(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.or_refresh_shipping_conversion(uuid) TO authenticated;

-- Only the Edge Function may submit trusted EasySlip results.
CREATE FUNCTION public.or_record_shipping_payment(p_request_id uuid,p_trans_ref text,p_amount numeric,p_storage_path text,p_slip_image_url text,p_response jsonb,p_verified_by uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE q public.or_shipping_conversion_requests;
BEGIN
 SELECT * INTO q FROM public.or_shipping_conversion_requests WHERE id=p_request_id FOR UPDATE;
 IF q.id IS NULL OR q.status<>'pending' THEN RAISE EXCEPTION 'คำขอไม่ได้รอดำเนินการ'; END IF;
 IF q.shipping_cost=0 AND q.zero_approved_by IS NULL THEN RAISE EXCEPTION 'ต้องอนุมัติค่าส่ง 0 ก่อนตรวจสลิปเพิ่ม'; END IF;
 IF p_amount > q.original_total+q.shipping_cost-public.or_shipping_verified_balance(q.id) THEN RAISE EXCEPTION 'ยอดสลิปเกินยอดคงเหลือ กรุณาให้บัญชีตรวจสอบก่อน'; END IF;
 IF nullif(btrim(p_trans_ref),'') IS NULL OR p_amount IS NULL OR p_amount::text='NaN' OR p_amount<=0 THEN RAISE EXCEPTION 'ผลสลิปไม่ถูกต้อง'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('SLIP:'||p_trans_ref,0));
 IF EXISTS(SELECT 1 FROM public.ac_verified_slips WHERE easyslip_trans_ref=p_trans_ref AND validation_status='passed') THEN RAISE EXCEPTION 'สลิปนี้เคยใช้แล้ว'; END IF;
 INSERT INTO public.or_shipping_conversion_payments(request_id,trans_ref,amount,storage_path,response)
 VALUES(q.id,p_trans_ref,p_amount,p_storage_path,p_response);
 -- Mirror into the existing accounting/reconciliation ledger atomically. The
 -- balance helper excludes these references from the original bill receipts.
 PERFORM set_config('app.shipping_payment_write','yes',true);
 INSERT INTO public.ac_verified_slips(order_id,slip_image_url,slip_storage_path,verified_amount,verified_by,easyslip_response,easyslip_trans_ref,
 easyslip_date,easyslip_receiver_bank_id,easyslip_receiver_account,is_validated,validation_status,expected_amount,account_name_match,bank_code_match)
 VALUES(q.order_id,p_slip_image_url,p_storage_path,p_amount,p_verified_by,p_response,p_trans_ref,
 nullif(p_response#>>'{data,date}','')::timestamptz,p_response#>>'{data,receiver,bank,id}',p_response#>>'{data,receiver,account,bank,account}',true,'passed',q.original_total+q.shipping_cost,true,true);
 PERFORM set_config('app.shipping_payment_write','no',true);
 UPDATE public.or_shipping_conversion_requests SET verification_error=NULL,last_verification_at=now() WHERE id=q.id;
 RETURN public.or_complete_shipping_conversion(q.id);
END $$;
REVOKE ALL ON FUNCTION public.or_record_shipping_payment(uuid,text,numeric,text,text,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.or_record_shipping_payment(uuid,text,numeric,text,text,jsonb,uuid) TO service_role;

CREATE FUNCTION public.or_guard_pickup_shipping()
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
 NEW.total_amount:=greatest(0,coalesce(NEW.total_amount,0)-coalesce(NEW.shipping_cost,0));
 NEW.shipping_cost:=0; NEW.customer_address:=''; NEW.tracking_number:=NULL;
 NEW.billing_details:=coalesce(NEW.billing_details,'{}'::jsonb)-ARRAY['address_line','sub_district','district','province','postal_code','mobile_phone','original_customer_address'];
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_01_pickup_shipping_guard BEFORE INSERT OR UPDATE ON public.or_orders FOR EACH ROW EXECUTE FUNCTION public.or_guard_pickup_shipping();
CREATE FUNCTION public.pk_guard_shipping_conversion_scan()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE target_order uuid;
BEGIN
 target_order:=CASE WHEN TG_OP='DELETE' THEN OLD.order_id ELSE NEW.order_id END;
 PERFORM 1 FROM public.or_orders WHERE id=target_order FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.or_shipping_conversion_requests WHERE order_id=target_order AND status='pending') THEN RAISE EXCEPTION 'รอตรวจค่าส่งหรืออนุมัติค่าส่ง 0 ก่อนแพ็ค'; END IF;
 IF EXISTS(SELECT 1 FROM public.or_shipping_conversion_requests q WHERE q.order_id=target_order AND q.status='ready' AND public.or_shipping_verified_balance(q.id)<q.original_total+q.shipping_cost) THEN RAISE EXCEPTION 'ยอดชำระเปลี่ยนไป ต้องตรวจสอบก่อนแพ็ค'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pk_shipping_conversion_scan_guard BEFORE INSERT OR UPDATE OR DELETE ON public.pk_packing_unit_scans FOR EACH ROW EXECUTE FUNCTION public.pk_guard_shipping_conversion_scan();

REVOKE ALL ON FUNCTION public.or_request_shipping_conversion(uuid,numeric,jsonb,text),public.or_review_zero_shipping(uuid,boolean,text),public.or_cancel_shipping_conversion(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.or_request_shipping_conversion(uuid,numeric,jsonb,text),public.or_review_zero_shipping(uuid,boolean,text),public.or_cancel_shipping_conversion(uuid,text) TO authenticated;
CREATE FUNCTION public.ac_guard_shipping_payment_duplicate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM public.or_shipping_conversion_payments WHERE trans_ref=OLD.easyslip_trans_ref) THEN
 IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.verified_amount IS DISTINCT FROM OLD.verified_amount OR NEW.is_deleted IS DISTINCT FROM OLD.is_deleted OR NEW.validation_status IS DISTINCT FROM OLD.validation_status OR NEW.easyslip_trans_ref IS DISTINCT FROM OLD.easyslip_trans_ref THEN RAISE EXCEPTION 'หลักฐานชำระค่าส่งที่ตรวจแล้วไม่สามารถแก้ไขยอดหรือย้ายบิลได้'; END IF;
 RETURN NEW;
 END IF;
 IF NEW.validation_status='passed' AND NEW.easyslip_trans_ref IS NOT NULL THEN
 PERFORM pg_advisory_xact_lock(hashtextextended('SLIP:'||NEW.easyslip_trans_ref,0));
 IF coalesce(current_setting('app.shipping_payment_write',true),'')<>'yes' AND EXISTS(SELECT 1 FROM public.or_shipping_conversion_payments WHERE trans_ref=NEW.easyslip_trans_ref) THEN RAISE EXCEPTION 'สลิปนี้ใช้ชำระการเปลี่ยนเป็นจัดส่งแล้ว'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ac_shipping_duplicate_guard BEFORE INSERT OR UPDATE ON public.ac_verified_slips FOR EACH ROW EXECUTE FUNCTION public.ac_guard_shipping_payment_duplicate();
ALTER FUNCTION public.pk_start_work_order_packing(text,timestamptz) RENAME TO pk_start_work_order_packing_before_shipping_guard;
REVOKE ALL ON FUNCTION public.pk_start_work_order_packing_before_shipping_guard(text,timestamptz) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.pk_start_work_order_packing(p_work_order_name text,p_started_at timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.or_orders WHERE work_order_name=p_work_order_name AND shipping_conversion_pending) AND NOT EXISTS(SELECT 1 FROM public.or_orders WHERE work_order_name=p_work_order_name AND NOT shipping_conversion_pending AND status NOT IN ('ยกเลิก','จัดส่งแล้ว')) THEN RAISE EXCEPTION 'ใบงานมีบิลรอตรวจค่าส่ง/อนุมัติค่าส่ง 0'; END IF;
 RETURN public.pk_start_work_order_packing_before_shipping_guard(p_work_order_name,p_started_at);
END $$;
REVOKE ALL ON FUNCTION public.pk_start_work_order_packing(text,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.pk_start_work_order_packing(text,timestamptz) TO authenticated;

INSERT INTO public.st_user_menus(role,menu_key,menu_name,has_access,updated_at)
SELECT role,'orders-shipping-conversion','เปลี่ยนเป็นจัดส่ง',role IN ('admin','sales-tr','sales-pump'),now()
FROM (VALUES ('admin'),('sales-tr'),('sales-pump'),('account'),('packing_staff'),('production')) roles(role)
ON CONFLICT(role,menu_key) DO UPDATE SET menu_name=excluded.menu_name,has_access=excluded.has_access,updated_at=now();
INSERT INTO public.st_user_menus(role,menu_key,menu_name,has_access,updated_at)
SELECT role,'account-zero-shipping','อนุมัติค่าส่ง 0',role IN ('admin','account'),now()
FROM (VALUES ('admin'),('sales-tr'),('sales-pump'),('account'),('packing_staff'),('production')) roles(role)
ON CONFLICT(role,menu_key) DO UPDATE SET menu_name=excluded.menu_name,has_access=excluded.has_access,updated_at=now();
NOTIFY pgrst, 'reload schema';
COMMIT;
