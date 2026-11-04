BEGIN;
-- Draft migration only: no backfill of old orders or external writes.
CREATE FUNCTION public.or_tax_receivable(p_total numeric,p_details jsonb) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
 SELECT round(p_total,2)-CASE WHEN p_details @> '{"withholding_requested":true}'::jsonb
 THEN round(round(p_total/(1+coalesce((p_details->>'vat_rate')::numeric,7)/100),2)*0.03,2) ELSE 0 END
$$;
ALTER TABLE public.or_orders ADD COLUMN receivable_amount numeric
 GENERATED ALWAYS AS (public.or_tax_receivable(total_amount,billing_details)) STORED;
CREATE TABLE public.or_tax_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES public.or_orders(id),
 kind text NOT NULL, action text NOT NULL, reason text, before_data jsonb, after_data jsonb,
 actor_id uuid NOT NULL REFERENCES public.us_users(id), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.or_tax_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY tax_audit_read ON public.or_tax_audit FOR SELECT TO authenticated
 USING (EXISTS(SELECT 1 FROM public.or_orders o WHERE o.id=order_id));
GRANT SELECT ON public.or_tax_audit TO authenticated;
REVOKE INSERT,UPDATE,DELETE ON public.or_tax_audit FROM authenticated,anon;
CREATE TABLE public.or_tax_invoice_counters (
 header_id uuid NOT NULL REFERENCES public.bill_header_settings(id), period text NOT NULL,
 last_number integer NOT NULL CHECK(last_number>=0), legacy_reviewed boolean NOT NULL DEFAULT false, PRIMARY KEY(header_id,period)
);
CREATE TABLE public.or_tax_invoices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL UNIQUE REFERENCES public.or_orders(id),
 header_id uuid NOT NULL REFERENCES public.bill_header_settings(id), invoice_no text NOT NULL,
 invoice_date date NOT NULL, snapshot jsonb NOT NULL, flow_account_reference text NOT NULL DEFAULT '',
 issued_by uuid NOT NULL REFERENCES public.us_users(id), issued_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(header_id,invoice_no)
);
ALTER TABLE public.or_tax_invoice_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.or_tax_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY tax_invoice_read ON public.or_tax_invoices FOR SELECT TO authenticated
 USING(EXISTS(SELECT 1 FROM public.or_orders o WHERE o.id=order_id));
REVOKE ALL ON public.or_tax_invoice_counters,public.or_tax_invoices FROM authenticated,anon;
GRANT SELECT ON public.or_tax_invoices TO authenticated;
CREATE FUNCTION public.or_tax_validate(p_details jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE tin text:=coalesce(p_details->>'tax_id',''); checksum integer:=0; i integer; a jsonb:=p_details->'tax_address';
BEGIN
 IF nullif(trim(p_details->>'tax_customer_name'),'') IS NULL OR nullif(trim(p_details->>'tax_customer_address'),'') IS NULL OR tin !~ '^\d{13}$' OR tin='0000000000000' THEN RAISE EXCEPTION 'กรอกชื่อ ที่อยู่ และเลขภาษี 13 หลักให้ครบ'; END IF;
 FOR i IN 1..12 LOOP checksum:=checksum+substring(tin,i,1)::integer*(14-i); END LOOP;
 IF (11-checksum%11)%10<>right(tin,1)::integer THEN RAISE EXCEPTION 'เลขตรวจสอบผู้เสียภาษีไม่ถูกต้อง'; END IF;
 IF coalesce(p_details->>'tax_branch','00000') !~ '^\d{5}$' THEN RAISE EXCEPTION 'เลขสาขาต้องมี 5 หลัก'; END IF;
 IF a IS NOT NULL AND a<>'null'::jsonb THEN
  IF coalesce(a->>'postal_code','') !~ '^\d{5}$' OR nullif(a->>'sub_district','') IS NULL OR nullif(a->>'district','') IS NULL OR nullif(a->>'province','') IS NULL THEN RAISE EXCEPTION 'เลือกตำบล อำเภอ จังหวัด และรหัสไปรษณีย์ให้ครบ'; END IF;
  IF NOT EXISTS(SELECT 1 FROM thai_sub_districts t JOIN thai_districts d ON d.id=t.district_id JOIN thai_provinces p ON p.id=d.province_id
    WHERE t.name_th=a->>'sub_district' AND d.name_th=a->>'district' AND p.name_th=a->>'province'
    AND (t.zip_code=a->>'postal_code' OR EXISTS(SELECT 1 FROM thai_sub_district_postal_aliases alias WHERE alias.sub_district_id=t.id AND alias.zip_code=a->>'postal_code'))) THEN RAISE EXCEPTION 'ที่อยู่ไม่สัมพันธ์กับรหัสไปรษณีย์'; END IF;
 END IF;
END $$;
CREATE FUNCTION public.or_tax_approved(p_details jsonb,p_kind text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN p_kind='invoice' AND coalesce((p_details->>'account_confirmed_tax')::boolean,false) AND NOT coalesce((p_details->>'tax_request_closed')::boolean,false)
 THEN true ELSE coalesce(p_details->'tax_workflow'->p_kind->>'status','pending')='approved' END
$$;
CREATE FUNCTION public.or_tax_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE controlled boolean:=coalesce(current_setting('app.tax_write',true),'')='yes';
 changed boolean; k text; old_bd jsonb:=CASE WHEN TG_OP='UPDATE' THEN coalesce(OLD.billing_details,'{}') ELSE '{}' END;
 bd jsonb:=coalesce(NEW.billing_details,'{}');
BEGIN
 IF TG_OP='INSERT' THEN
  -- A new bill may copy buyer data, but never another bill's approval or documents.
  bd:=bd-ARRAY['tax_workflow','withholding_receipt','account_confirmed_tax','account_confirmed_tax_at','account_confirmed_tax_by','erp_tax_invoice_no','tax_request_closed','tax_request_closed_reason'];
 END IF;
 IF bd @> '{"withholding_requested":true}' THEN
  bd:=jsonb_set(bd,'{request_tax_invoice}','true');
  IF NEW.total_amount<0 OR coalesce((bd->>'vat_rate')::numeric,7)<0 THEN RAISE EXCEPTION 'ยอดบิลหรือ VAT ไม่ถูกต้อง'; END IF;
 END IF;
 IF NOT controlled THEN
  IF (bd->'tax_workflow') IS DISTINCT FROM (old_bd->'tax_workflow')
   OR (bd->'withholding_receipt') IS DISTINCT FROM (old_bd->'withholding_receipt')
   OR (bd->'account_confirmed_tax_at') IS DISTINCT FROM (old_bd->'account_confirmed_tax_at')
   OR (bd->'account_confirmed_tax_by') IS DISTINCT FROM (old_bd->'account_confirmed_tax_by')
   OR (bd->'erp_tax_invoice_no') IS DISTINCT FROM (old_bd->'erp_tax_invoice_no')
   OR (bd->'account_confirmed_tax') IS DISTINCT FROM (old_bd->'account_confirmed_tax') THEN
   RAISE EXCEPTION 'ต้องดำเนินการอนุมัติผ่านขั้นตอน TAX';
  END IF;
  IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM public.ac_verified_slips s WHERE s.order_id=NEW.id AND NOT coalesce(s.is_deleted,false) AND s.validation_status='passed') THEN
   IF coalesce(bd @> '{"request_tax_invoice":true}',false) IS DISTINCT FROM coalesce(old_bd @> '{"request_tax_invoice":true}',false)
    OR coalesce(bd @> '{"withholding_requested":true}',false) IS DISTINCT FROM coalesce(old_bd @> '{"withholding_requested":true}',false)
    OR coalesce(bd->>'vat_rate','7') IS DISTINCT FROM coalesce(old_bd->>'vat_rate','7') THEN
    RAISE EXCEPTION 'บิลผ่าน EasySlip แล้ว เปลี่ยนคำขอเอกสารภาษีย้อนหลังไม่ได้';
   END IF;
  END IF;
  changed:=false;
  FOREACH k IN ARRAY ARRAY['tax_customer_name','tax_customer_address','tax_id','tax_branch','tax_address','request_tax_invoice','withholding_requested'] LOOP
    IF (bd->k) IS DISTINCT FROM (old_bd->k) THEN changed:=true; END IF;
  END LOOP;
  IF TG_OP='UPDATE' AND changed AND (public.or_tax_approved(old_bd,'invoice') OR public.or_tax_approved(old_bd,'withholding')
   OR old_bd->'tax_workflow'->'invoice'->>'status'='rejected') THEN
   RAISE EXCEPTION 'แก้ข้อมูลคำขอเดิมผ่านเมนู TAX เท่านั้น';
  END IF;
 END IF;
 IF TG_OP='UPDATE' AND (NEW.total_amount IS DISTINCT FROM OLD.total_amount OR NEW.shipping_cost IS DISTINCT FROM OLD.shipping_cost OR NEW.discount IS DISTINCT FROM OLD.discount OR NEW.price IS DISTINCT FROM OLD.price OR bd->'tax_items' IS DISTINCT FROM old_bd->'tax_items') THEN
  IF EXISTS(SELECT 1 FROM public.or_tax_invoices WHERE order_id=NEW.id) OR coalesce((old_bd->>'account_confirmed_tax')::boolean,false) AND NOT coalesce((old_bd->>'tax_request_closed')::boolean,false) THEN RAISE EXCEPTION 'ออกใบกำกับแล้ว ต้องใช้กระบวนการแก้เอกสารบัญชี'; END IF;
  IF bd @> '{"request_tax_invoice":true}' THEN
   bd:=jsonb_set(bd,'{tax_workflow}',jsonb_build_object('invoice',jsonb_build_object('status','pending'),'withholding',jsonb_build_object('status','pending')));
  END IF;
 END IF;
 IF (NEW.work_order_id IS NOT NULL OR nullif(trim(NEW.work_order_name),'') IS NOT NULL OR NEW.status='ใบสั่งงาน')
 AND (TG_OP='INSERT' OR NEW.work_order_id IS DISTINCT FROM OLD.work_order_id OR NEW.work_order_name IS DISTINCT FROM OLD.work_order_name OR NEW.status='ใบสั่งงาน' AND OLD.status IS DISTINCT FROM NEW.status) THEN
  IF bd @> '{"request_tax_invoice":true}' AND NOT public.or_tax_approved(bd,'invoice') THEN RAISE EXCEPTION 'รอบัญชีอนุมัติใบกำกับภาษี'; END IF;
  IF bd @> '{"withholding_requested":true}' AND NOT public.or_tax_approved(bd,'withholding') THEN RAISE EXCEPTION 'รอบัญชีอนุมัติหัก ณ ที่จ่าย'; END IF;
 END IF;
 NEW.billing_details:=CASE WHEN NEW.billing_details IS NULL AND bd='{}'::jsonb THEN NULL ELSE bd END;
 RETURN NEW;
END $$;
CREATE TRIGGER zzzzz_tax_guard BEFORE INSERT OR UPDATE ON public.or_orders FOR EACH ROW EXECUTE FUNCTION public.or_tax_guard();
CREATE FUNCTION public.or_tax_require_menu(p_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM us_users u WHERE u.id=auth.uid() AND (u.role='superadmin' OR EXISTS(SELECT 1 FROM st_user_menus m WHERE m.role=u.role AND m.menu_key=p_key AND m.has_access))) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์เมนูนี้'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.or_tax_require_menu(text) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.or_tax_action(p_order_id uuid,p_kind text,p_action text,p_payload jsonb DEFAULT '{}') RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.or_orders; role_name text; bd jsonb; prior jsonb; workflow jsonb; state text; reason text; patch jsonb;
BEGIN
 SELECT role INTO role_name FROM public.us_users WHERE id=auth.uid();
 IF role_name IS NULL THEN RAISE EXCEPTION 'ไม่มีสิทธิ์'; END IF;
 SELECT * INTO o FROM public.or_orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.or_orders WHERE id=p_order_id) THEN RAISE EXCEPTION 'ไม่พบบิล'; END IF;
 -- SECURITY DEFINER must separately enforce the caller's order visibility.
 IF role_name IN ('sales-tr','sales-pump') AND NOT EXISTS(SELECT 1 FROM public.us_users u WHERE (u.id=auth.uid() OR role_name='sales-tr' AND u.role='sales-tr') AND (u.username=o.admin_user OR u.email=o.admin_user)) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์จัดการบิลนี้'; END IF;
 IF role_name NOT IN ('sales-tr','sales-pump','account','superadmin','admin') OR o.status='ยกเลิก' THEN RAISE EXCEPTION 'ไม่สามารถทำรายการ'; END IF;
 PERFORM public.or_tax_require_menu(CASE WHEN p_action='resubmit' THEN 'orders-tax' WHEN p_kind='invoice' THEN 'account-tax-invoice' ELSE 'account-withholding' END);
 IF p_kind NOT IN ('invoice','withholding') THEN RAISE EXCEPTION 'ประเภทไม่ถูกต้อง'; END IF;
 bd:=coalesce(o.billing_details,'{}'); prior:=bd;
 IF NOT (bd @> CASE WHEN p_kind='invoice' THEN '{"request_tax_invoice":true}'::jsonb ELSE '{"withholding_requested":true}'::jsonb END) THEN RAISE EXCEPTION 'บิลไม่มีคำขอนี้'; END IF;
 workflow:=coalesce(bd->'tax_workflow','{}'); state:=coalesce(workflow->p_kind->>'status','pending');
 IF p_action IN ('approve','reject') THEN
  IF role_name NOT IN ('account','superadmin') THEN RAISE EXCEPTION 'เฉพาะบัญชีอนุมัติได้'; END IF;
  IF p_action='approve' AND (state<>'pending' OR public.or_tax_approved(bd,p_kind)) OR p_action='reject' AND state NOT IN ('pending','approved') THEN RAISE EXCEPTION 'สถานะคำขอไม่รองรับการทำรายการ'; END IF;
  IF p_action='reject' AND (o.work_order_id IS NOT NULL OR nullif(trim(o.work_order_name),'') IS NOT NULL OR EXISTS(SELECT 1 FROM or_tax_invoices WHERE order_id=o.id) OR bd->'withholding_receipt' IS NOT NULL) THEN RAISE EXCEPTION 'บิลเริ่มดำเนินงานหรือมีเอกสารแล้ว ส่งกลับแก้ไขไม่ได้'; END IF;
  IF p_payload->'expected_details' IS DISTINCT FROM bd OR (p_payload->>'expected_total')::numeric IS DISTINCT FROM o.total_amount THEN RAISE EXCEPTION 'ข้อมูลเปลี่ยนแล้ว กรุณารีเฟรชและตรวจใหม่'; END IF;
  reason:=nullif(trim(p_payload->>'reason'),'');
  IF p_action='reject' AND reason IS NULL THEN RAISE EXCEPTION 'กรุณาระบุเหตุผล'; END IF;
  IF p_action='approve' THEN PERFORM public.or_tax_validate(bd); END IF;
  workflow:=jsonb_set(workflow,ARRAY[p_kind],jsonb_build_object('status',CASE WHEN p_action='approve' THEN 'approved' ELSE 'rejected' END,'reason',reason,'by',auth.uid(),'at',now()));
  bd:=jsonb_set(bd,'{tax_workflow}',workflow);
 ELSIF p_action='resubmit' THEN
  IF role_name NOT IN ('sales-tr','sales-pump','superadmin','admin') OR state<>'rejected' THEN RAISE EXCEPTION 'คำขอไม่อยู่ระหว่างแก้ไข'; END IF;
  IF o.work_order_id IS NOT NULL OR nullif(trim(o.work_order_name),'') IS NOT NULL THEN RAISE EXCEPTION 'บิลเข้าใบสั่งงานแล้ว'; END IF;
  IF EXISTS(SELECT 1 FROM public.or_tax_invoices WHERE order_id=o.id) THEN RAISE EXCEPTION 'ออกเอกสารแล้ว แก้ข้อมูลไม่ได้'; END IF;
  SELECT coalesce(jsonb_object_agg(key,value),'{}') INTO patch FROM jsonb_each(p_payload) WHERE key IN ('tax_customer_name','tax_customer_address','tax_id','tax_branch','tax_address');
  IF nullif(trim(patch->>'tax_customer_name'),'') IS NULL OR coalesce(patch->>'tax_id','') !~ '^\d{13}$' OR nullif(trim(patch->>'tax_customer_address'),'') IS NULL THEN RAISE EXCEPTION 'กรอกข้อมูลภาษีให้ครบ'; END IF;
  bd:=bd||patch;
  PERFORM public.or_tax_validate(bd);
  workflow:=jsonb_set(workflow,ARRAY[p_kind],jsonb_build_object('status','pending','by',auth.uid(),'at',now()));
  -- Shared buyer data changed: invalidate the other approval too.
  IF bd @> '{"withholding_requested":true}' THEN workflow:=jsonb_set(workflow,ARRAY[CASE WHEN p_kind='invoice' THEN 'withholding' ELSE 'invoice' END],jsonb_build_object('status','pending','at',now())); END IF;
  bd:=jsonb_set(bd,'{tax_workflow}',workflow);
 ELSIF p_action='received' THEN
  IF role_name NOT IN ('account','superadmin') OR p_kind<>'withholding' OR NOT public.or_tax_approved(bd,p_kind) THEN RAISE EXCEPTION 'ยังไม่อนุมัติหรือไม่มีสิทธิ์'; END IF;
  IF bd->'withholding_receipt' IS NOT NULL THEN RAISE EXCEPTION 'บันทึกรับเอกสารแล้ว'; END IF;
  IF nullif(trim(p_payload->>'reference'),'') IS NULL OR nullif(p_payload->>'date','') IS NULL OR nullif(trim(p_payload->>'file_path'),'') IS NULL THEN RAISE EXCEPTION 'กรอกเลขเอกสาร วันที่ และแนบไฟล์'; END IF;
  IF (p_payload->>'date')::date>(now() AT TIME ZONE 'Asia/Bangkok')::date THEN RAISE EXCEPTION 'วันที่เอกสารอยู่ในอนาคต'; END IF;
  IF NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='tax-evidence' AND name=p_payload->>'file_path' AND (storage.foldername(name))[1]=o.id::text) THEN RAISE EXCEPTION 'ไม่พบไฟล์แนบของบิลนี้'; END IF;
  bd:=jsonb_set(bd,'{withholding_receipt}',p_payload||jsonb_build_object('by',auth.uid(),'at',now()));
 ELSE RAISE EXCEPTION 'การทำรายการไม่ถูกต้อง'; END IF;
 PERFORM set_config('app.tax_write','yes',true);
 UPDATE public.or_orders SET billing_details=bd WHERE id=o.id;
 INSERT INTO public.or_tax_audit(order_id,kind,action,reason,before_data,after_data,actor_id) VALUES(o.id,p_kind,p_action,reason,prior,bd,auth.uid());
 PERFORM set_config('app.tax_write','',true);
END $$;
REVOKE ALL ON FUNCTION public.or_tax_action(uuid,text,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.or_tax_action(uuid,text,text,jsonb) TO authenticated;
INSERT INTO public.st_user_menus(role,menu_key,menu_name,has_access)
 SELECT r,k,n,a FROM (VALUES ('sales-tr',true),('sales-pump',true),('admin',true),('account',false)) roles(r,a)
 CROSS JOIN (VALUES('orders-tax','TAX')) menus(k,n)
 ON CONFLICT(role,menu_key) DO NOTHING;
INSERT INTO public.st_user_menus(role,menu_key,menu_name,has_access)
 VALUES('account','account-withholding','ขอหัก ณ ที่จ่าย',true),('admin','account-withholding','ขอหัก ณ ที่จ่าย',true)
 ON CONFLICT(role,menu_key) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
