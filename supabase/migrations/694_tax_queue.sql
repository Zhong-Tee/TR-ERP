BEGIN;
CREATE FUNCTION public.or_tax_queue(p_mode text,p_state text DEFAULT 'pending',p_search text DEFAULT '',p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 WITH actor AS (SELECT * FROM us_users WHERE id=auth.uid()), entries AS (
 SELECT to_jsonb(o)||jsonb_build_object('tax_document',(SELECT jsonb_build_object('invoice_no',doc.invoice_no,'flow_account_reference',doc.flow_account_reference) FROM or_tax_invoices doc WHERE doc.order_id=o.id)) order_data,o.id,o.created_at,k.kind,
  CASE WHEN k.kind='invoice' AND coalesce((o.billing_details->>'account_confirmed_tax')::boolean,false) THEN 'approved'
   ELSE coalesce(o.billing_details->'tax_workflow'->k.kind->>'status','pending') END state,
  k.kind='invoice' AND coalesce((o.billing_details->>'account_confirmed_tax')::boolean,false) issued,
  o.billing_details->'withholding_receipt' IS NOT NULL received
 FROM or_orders o CROSS JOIN actor CROSS JOIN (VALUES('invoice'),('withholding')) k(kind)
 WHERE o.status<>'ยกเลิก' AND NOT coalesce((o.billing_details->>'tax_request_closed')::boolean,false) AND o.billing_details @> '{"request_tax_invoice":true}'
  AND (k.kind='invoice' OR o.billing_details @> '{"withholding_requested":true}')
  AND (p_mode='sales' OR p_mode=k.kind)
  AND (actor.role='superadmin' OR EXISTS(SELECT 1 FROM st_user_menus m WHERE m.role=actor.role AND m.has_access AND m.menu_key=CASE WHEN p_mode='sales' THEN 'orders-tax' WHEN p_mode='invoice' THEN 'account-tax-invoice' ELSE 'account-withholding' END))
  AND (actor.role IN ('superadmin','admin','account') OR actor.role='sales-pump' AND o.admin_user IN (actor.username,actor.email)
    OR actor.role='sales-tr' AND EXISTS(SELECT 1 FROM us_users owner WHERE owner.role='sales-tr' AND o.admin_user IN (owner.username,owner.email)))
  AND (p_search='' OR strpos(lower(o.bill_no),lower(p_search))>0)
 ), filtered AS (SELECT * FROM entries WHERE CASE WHEN p_state='awaiting_receipt' THEN kind='withholding' AND state='approved' AND NOT received WHEN p_state='received' THEN kind='withholding' AND received WHEN p_state='issued' THEN issued WHEN p_state='approved' THEN state='approved' AND NOT issued ELSE state=p_state END),
 page AS (SELECT * FROM filtered ORDER BY created_at DESC,id,kind LIMIT 50 OFFSET greatest(0,p_offset))
 SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(to_jsonb(page)) FROM page),'[]'),
  'total',(SELECT count(*) FROM filtered),'rejected_total',(SELECT count(*) FROM entries WHERE state='rejected'),
  'counts',jsonb_build_object('pending',(SELECT count(*) FROM entries WHERE state='pending'),'rejected',(SELECT count(*) FROM entries WHERE state='rejected'),
   'approved',(SELECT count(*) FROM entries WHERE state='approved' AND NOT issued),'issued',(SELECT count(*) FROM entries WHERE issued),
   'awaiting_receipt',(SELECT count(*) FROM entries WHERE kind='withholding' AND state='approved' AND NOT received),'received',(SELECT count(*) FROM entries WHERE kind='withholding' AND received)))
$$;
REVOKE ALL ON FUNCTION public.or_tax_queue(text,text,text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.or_tax_queue(text,text,text,integer) TO authenticated;
CREATE FUNCTION public.or_tax_close_cancelled(p_order_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.or_orders; bd jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM us_users WHERE id=auth.uid() AND role IN ('account','superadmin')) THEN RAISE EXCEPTION 'เฉพาะบัญชีปิดคำขอได้'; END IF;
 PERFORM public.or_tax_require_menu('account-tax-invoice');
 SELECT * INTO o FROM or_orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND OR o.status<>'ยกเลิก' THEN RAISE EXCEPTION 'ปิดได้เฉพาะบิลยกเลิก'; END IF;
 bd:=coalesce(o.billing_details,'{}')||jsonb_build_object('account_confirmed_tax',true,'account_confirmed_tax_at',now(),'account_confirmed_tax_by',auth.uid(),'tax_request_closed',true,'tax_request_closed_reason','ยกเลิกบิล');
 PERFORM set_config('app.tax_write','yes',true);
 UPDATE or_orders SET billing_details=bd WHERE id=o.id;
 INSERT INTO or_tax_audit(order_id,kind,action,before_data,after_data,actor_id) VALUES(o.id,'invoice','close_cancelled',o.billing_details,bd,auth.uid());
 PERFORM set_config('app.tax_write','',true);
END $$;
REVOKE ALL ON FUNCTION public.or_tax_close_cancelled(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.or_tax_close_cancelled(uuid) TO authenticated;
COMMIT;
