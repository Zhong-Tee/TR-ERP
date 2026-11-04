-- A company cannot reuse an invoice number, even with different letter case.
CREATE UNIQUE INDEX or_tax_invoices_company_number_normalized
ON public.or_tax_invoices(header_id, lower(trim(invoice_no)));

CREATE FUNCTION public.or_tax_recover_legacy_invoice(p_order_id uuid, p_header_id uuid, p_date date, p_invoice_no text, p_snapshot jsonb, p_flow_reference text DEFAULT ''::text) RETURNS public.or_tax_invoices
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE o public.or_orders; h public.bill_header_settings; doc public.or_tax_invoices; expected_items jsonb; vat_rate numeric; base numeric; item_total numeric; canonical jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM us_users WHERE id=auth.uid() AND role IN ('account','superadmin')) THEN RAISE EXCEPTION 'เฉพาะบัญชีออกเอกสารได้'; END IF;
 PERFORM public.or_tax_require_menu('account-tax-invoice');
 SELECT * INTO o FROM or_orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND OR o.status='ยกเลิก' OR NOT coalesce(o.billing_details @> '{"request_tax_invoice":true}',false) THEN RAISE EXCEPTION 'บิลไม่มีคำขอ'; END IF;
 SELECT * INTO doc FROM or_tax_invoices WHERE order_id=o.id;
 IF FOUND THEN RAISE EXCEPTION 'รายการนี้มีเลขใบกำกับในทะเบียนแล้ว'; END IF;

 -- Previously issued legacy documents need manual recovery, never a new number.
 IF NOT coalesce((o.billing_details->>'account_confirmed_tax')::boolean,false) THEN RAISE EXCEPTION 'บันทึกเลขเดิมได้เฉพาะรายการเก่าที่เคยยืนยันแล้ว'; END IF;
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
 IF nullif(trim(p_invoice_no),'') IS NULL THEN RAISE EXCEPTION 'กรุณากรอกเลขใบกำกับเดิม'; END IF;
 -- Serialize recovery requests for this company. The unique index also
 -- protects against concurrent automatic issuance and case variants.
 PERFORM pg_advisory_xact_lock(hashtextextended(h.id::text,0));
 IF EXISTS(SELECT 1 FROM or_tax_invoices WHERE header_id=h.id AND lower(trim(invoice_no))=lower(trim(p_invoice_no))) THEN
   RAISE EXCEPTION 'เลขใบกำกับนี้ถูกใช้แล้วในบริษัทที่เลือก';
 END IF;
 INSERT INTO or_tax_invoices(order_id,header_id,invoice_no,invoice_date,snapshot,flow_account_reference,issued_by)
 VALUES(o.id,h.id,trim(p_invoice_no),p_date,
 p_snapshot||canonical||jsonb_build_object('companyData',to_jsonb(h),'orderBilling',o.billing_details,'orderTotal',o.total_amount),coalesce(trim(p_flow_reference),''),auth.uid()) RETURNING * INTO doc;
 PERFORM set_config('app.tax_write','yes',true);
 UPDATE or_orders SET billing_details=coalesce(billing_details,'{}')||jsonb_build_object('account_confirmed_tax',true,'erp_tax_invoice_no',doc.invoice_no) WHERE id=o.id;
 PERFORM set_config('app.tax_write','',true);
 INSERT INTO or_tax_audit(order_id,kind,action,after_data,actor_id) VALUES(o.id,'invoice','recover_legacy',to_jsonb(doc),auth.uid());
 RETURN doc;
EXCEPTION WHEN unique_violation THEN
 RAISE EXCEPTION 'เลขใบกำกับนี้ถูกใช้แล้ว หรือรายการนี้มีเลขในทะเบียนแล้ว';
END $$;
REVOKE ALL ON FUNCTION public.or_tax_recover_legacy_invoice(uuid,uuid,date,text,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.or_tax_recover_legacy_invoice(uuid,uuid,date,text,jsonb,text) TO authenticated;
