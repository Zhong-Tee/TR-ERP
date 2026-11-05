BEGIN;

-- Accept presentation separators, preserving 13-digit/checksum validation.
-- Approval validates without rewriting historical buyer data; resubmission stores canonical IDs.
CREATE OR REPLACE FUNCTION public.or_tax_validate(p_details jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE tin text:=regexp_replace(coalesce(p_details->>'tax_id',''),'[[:space:]-]','','g'); checksum integer:=0; i integer; a jsonb:=p_details->'tax_address';
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

CREATE OR REPLACE FUNCTION public.or_tax_action(p_order_id uuid,p_kind text,p_action text,p_payload jsonb DEFAULT '{}') RETURNS void
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
  patch:=patch||jsonb_build_object('tax_id',regexp_replace(coalesce(patch->>'tax_id',''),'[[:space:]-]','','g'));
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

COMMIT;
