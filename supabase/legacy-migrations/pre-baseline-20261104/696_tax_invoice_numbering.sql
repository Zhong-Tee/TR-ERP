BEGIN;
CREATE FUNCTION public.or_issue_tax_invoice(p_order_id uuid,p_header_id uuid,p_date date,p_snapshot jsonb,p_flow_reference text DEFAULT '')
RETURNS public.or_tax_invoices LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.or_orders; h public.bill_header_settings; doc public.or_tax_invoices; period_key text; next_number integer; expected_items jsonb; vat_rate numeric; base numeric; item_total numeric; canonical jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM us_users WHERE id=auth.uid() AND role IN ('account','superadmin')) THEN RAISE EXCEPTION 'เฉพาะบัญชีออกเอกสารได้'; END IF;
 PERFORM public.or_tax_require_menu('account-tax-invoice');
 SELECT * INTO o FROM or_orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND OR o.status='ยกเลิก' OR NOT coalesce(o.billing_details @> '{"request_tax_invoice":true}',false) THEN RAISE EXCEPTION 'บิลไม่มีคำขอ'; END IF;
 SELECT * INTO doc FROM or_tax_invoices WHERE order_id=o.id;
 IF FOUND THEN RETURN doc; END IF;
 IF NOT public.or_tax_approved(o.billing_details,'invoice') THEN RAISE EXCEPTION 'รออนุมัติข้อมูลใบกำกับภาษี'; END IF;
 -- Previously issued legacy documents need manual recovery, never a new number.
 IF coalesce((o.billing_details->>'account_confirmed_tax')::boolean,false) THEN RAISE EXCEPTION 'เอกสารเก่า กรุณาตรวจเลขที่เคยออกก่อนนำเข้าทะเบียน'; END IF;
 SELECT * INTO h FROM bill_header_settings WHERE id=p_header_id;
 IF NOT FOUND OR nullif(trim(h.bill_code),'') IS NULL OR p_date IS NULL OR p_date>(now() AT TIME ZONE 'Asia/Bangkok')::date THEN RAISE EXCEPTION 'เลือกบริษัทและวันที่ให้ถูกต้อง'; END IF;
 IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot)<>'object' THEN RAISE EXCEPTION 'ข้อมูลเอกสารไม่ถูกต้อง'; END IF;
 IF p_snapshot->>'customerName' IS DISTINCT FROM o.billing_details->>'tax_customer_name'
 OR p_snapshot->>'customerTaxId' IS DISTINCT FROM o.billing_details->>'tax_id'
 OR p_snapshot->>'customerAddress' IS DISTINCT FROM o.billing_details->>'tax_customer_address'
 OR abs(coalesce((p_snapshot->>'grandTotal')::numeric,-1)-o.total_amount)>0.01 THEN RAISE EXCEPTION 'ข้อมูลเอกสารไม่ตรงกับข้อมูลที่อนุมัติ'; END IF;
 IF jsonb_typeof(o.billing_details->'tax_items')='array' AND jsonb_array_length(o.billing_details->'tax_items')>0 THEN
  SELECT jsonb_agg(jsonb_build_object('description',t->>'product_name','quantity',(t->>'quantity')::numeric,'unitPrice',(t->>'unit_price')::numeric,'amount',(t->>'quantity')::numeric*(t->>'unit_price')::numeric)) INTO expected_items FROM jsonb_array_elements(o.billing_details->'tax_items') t;
  IF p_snapshot->'items' IS DISTINCT FROM expected_items THEN RAISE EXCEPTION 'รายการสินค้าไม่ตรงกับข้อมูลที่อนุมัติ'; END IF;
 END IF;
 vat_rate:=coalesce((o.billing_details->>'vat_rate')::numeric,7);
 base:=round(o.total_amount/(1+vat_rate/100),2);
 item_total:=o.total_amount+coalesce(o.discount,0)-coalesce(o.shipping_cost,0);
 canonical:=jsonb_build_object('customerName',o.billing_details->>'tax_customer_name','customerAddress',o.billing_details->>'tax_customer_address','customerTaxId',o.billing_details->>'tax_id',
 'customerBranch',CASE WHEN coalesce(o.billing_details->>'tax_branch','00000')='00000' THEN 'สำนักงานใหญ่' ELSE 'สาขา '||(o.billing_details->>'tax_branch') END,
 'customerPhone',coalesce(o.billing_details->>'tax_customer_phone',o.billing_details->>'mobile_phone',''),
 'items',coalesce(expected_items,jsonb_build_array(jsonb_build_object('description','สินค้า','quantity',1,'unitPrice',item_total,'amount',item_total))),
 'discount',coalesce(o.discount,0),'shippingCost',coalesce(o.shipping_cost,0),'subtotal',item_total,'netAmount',base,'vatAmount',o.total_amount-base,'vatRate',vat_rate,'grandTotal',o.total_amount);
 period_key:=to_char(p_date,'YYMM');
 IF EXISTS(SELECT 1 FROM or_orders legacy WHERE coalesce((legacy.billing_details->>'account_confirmed_tax')::boolean,false) AND NOT coalesce((legacy.billing_details->>'tax_request_closed')::boolean,false)
   AND NOT EXISTS(SELECT 1 FROM or_tax_invoices issued WHERE issued.order_id=legacy.id)
   AND to_char(coalesce(nullif(legacy.billing_details->>'account_confirmed_tax_at','')::timestamptz,legacy.created_at) AT TIME ZONE 'Asia/Bangkok','YYMM')=period_key)
   AND NOT EXISTS(SELECT 1 FROM or_tax_invoice_counters WHERE header_id=h.id AND period=period_key AND legacy_reviewed) THEN
   RAISE EXCEPTION 'มีเอกสารเก่าในเดือนนี้ กรุณาตรวจทะเบียนและยืนยันเลขล่าสุดก่อนเริ่มรันเลขใหม่';
 END IF;
 INSERT INTO or_tax_invoice_counters(header_id,period,last_number) VALUES(h.id,period_key,1)
 ON CONFLICT(header_id,period) DO UPDATE SET last_number=or_tax_invoice_counters.last_number+1
 RETURNING last_number INTO next_number;
 IF next_number>9999 THEN RAISE EXCEPTION 'เลขเอกสารเกิน 9999 รายการในเดือนนี้'; END IF;
 INSERT INTO or_tax_invoices(order_id,header_id,invoice_no,invoice_date,snapshot,flow_account_reference,issued_by)
 VALUES(o.id,h.id,h.bill_code||'IV'||period_key||lpad(next_number::text,4,'0'),p_date,
 p_snapshot||canonical||jsonb_build_object('companyData',to_jsonb(h),'orderBilling',o.billing_details,'orderTotal',o.total_amount),coalesce(trim(p_flow_reference),''),auth.uid()) RETURNING * INTO doc;
 PERFORM set_config('app.tax_write','yes',true);
 UPDATE or_orders SET billing_details=coalesce(billing_details,'{}')||jsonb_build_object('account_confirmed_tax',true,'account_confirmed_tax_at',now(),'account_confirmed_tax_by',auth.uid(),'erp_tax_invoice_no',doc.invoice_no) WHERE id=o.id;
 PERFORM set_config('app.tax_write','',true);
 INSERT INTO or_tax_audit(order_id,kind,action,after_data,actor_id) VALUES(o.id,'invoice','issue',to_jsonb(doc),auth.uid());
 RETURN doc;
END $$;
CREATE FUNCTION public.or_tax_flow_reference(p_order_id uuid,p_reference text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE previous text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM us_users WHERE id=auth.uid() AND role IN ('account','superadmin')) THEN RAISE EXCEPTION 'เฉพาะบัญชีแก้เลขอ้างอิงได้'; END IF;
 PERFORM public.or_tax_require_menu('account-tax-invoice');
 SELECT flow_account_reference INTO previous FROM or_tax_invoices WHERE order_id=p_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ยังไม่ได้ออกเอกสาร ERP'; END IF;
 UPDATE or_tax_invoices SET flow_account_reference=coalesce(trim(p_reference),'') WHERE order_id=p_order_id;
 INSERT INTO or_tax_audit(order_id,kind,action,before_data,after_data,actor_id)
 VALUES(p_order_id,'invoice','flow_reference',jsonb_build_object('reference',previous),jsonb_build_object('reference',p_reference),auth.uid());
END $$;
CREATE FUNCTION public.or_tax_initialize_series(p_order_id uuid,p_header_id uuid,p_period text,p_last_number integer,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE previous integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM us_users WHERE id=auth.uid() AND role IN ('account','superadmin')) THEN RAISE EXCEPTION 'เฉพาะบัญชีตั้งค่าเลขเอกสารได้'; END IF;
 PERFORM public.or_tax_require_menu('account-tax-invoice');
 IF p_period !~ '^\d{2}(0[1-9]|1[0-2])$' OR p_last_number<0 OR p_last_number>9999 OR nullif(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'ระบุเดือน เลขล่าสุด และเหตุผลให้ถูกต้อง'; END IF;
 IF NOT EXISTS(SELECT 1 FROM or_orders WHERE id=p_order_id) THEN RAISE EXCEPTION 'ไม่พบบิล'; END IF;
 SELECT last_number INTO previous FROM or_tax_invoice_counters WHERE header_id=p_header_id AND period=p_period FOR UPDATE;
 IF previous IS NOT NULL AND p_last_number<previous THEN RAISE EXCEPTION 'ห้ามลดเลขลำดับที่ใช้แล้ว'; END IF;
 INSERT INTO or_tax_invoice_counters(header_id,period,last_number,legacy_reviewed) VALUES(p_header_id,p_period,p_last_number,true)
 ON CONFLICT(header_id,period) DO UPDATE SET last_number=greatest(or_tax_invoice_counters.last_number,excluded.last_number),legacy_reviewed=true;
 INSERT INTO or_tax_audit(order_id,kind,action,reason,before_data,after_data,actor_id)
 VALUES(p_order_id,'invoice','initialize_series',trim(p_reason),jsonb_build_object('last_number',previous),jsonb_build_object('header_id',p_header_id,'period',p_period,'last_number',p_last_number),auth.uid());
END $$;
REVOKE ALL ON FUNCTION public.or_tax_initialize_series(uuid,uuid,text,integer,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.or_tax_initialize_series(uuid,uuid,text,integer,text) TO authenticated;
REVOKE ALL ON FUNCTION public.or_issue_tax_invoice(uuid,uuid,date,jsonb,text),public.or_tax_flow_reference(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.or_issue_tax_invoice(uuid,uuid,date,jsonb,text),public.or_tax_flow_reference(uuid,text) TO authenticated;
COMMIT;
