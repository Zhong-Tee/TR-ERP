-- Installs read-only audit and guarded corrections; installation changes NO stock quantities.
BEGIN;
CREATE TABLE public.inv_reservation_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES public.pr_products(id),
  old_reserved numeric NOT NULL,
  new_reserved numeric NOT NULL,
  reason text NOT NULL,
  evidence jsonb NOT NULL,
  actor_id uuid DEFAULT auth.uid(),
  actor_database_user text NOT NULL DEFAULT session_user,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.inv_reservation_reconciliations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inv_reservation_reconciliations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.inv_reservation_reconciliations TO authenticated;
CREATE POLICY reconciliation_history_read ON public.inv_reservation_reconciliations FOR SELECT TO authenticated
USING(public.check_user_role(auth.uid(),ARRAY['superadmin','admin','store','account']));

CREATE FUNCTION public.fn_reservation_audit(p_product_ids uuid[] DEFAULT NULL)
RETURNS TABLE(product_id uuid,product_code text,product_name text,unit_name text,
  on_hand numeric,reserved numeric,document_reserved numeric,wms_reserved numeric,borrow_reserved numeric,
  linked_reserved numeric,difference numeric,completed_wms_count bigint,uncertain_count bigint,
  classification text,evidence jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
WITH products AS (
 SELECT p.id,p.product_code,p.product_name,p.unit_name,
   count(*) OVER(PARTITION BY upper(btrim(p.product_code))) AS code_count
 FROM public.pr_products p
), wms AS (
 SELECT p.id AS product_id,w.id,w.order_id,w.qty,w.status,w.status_before_cancel,w.stock_action,
   coalesce(m.net_deducted,0) AS net_deducted,
   CASE WHEN w.status='picked' OR (w.status='cancelled' AND w.status_before_cancel='picked' AND w.stock_action IS NULL)
     THEN coalesce(w.qty,0) ELSE 0 END AS held,
   CASE WHEN p.code_count>1 OR w.qty IS NULL OR w.qty<0 OR w.status IS NULL
     OR w.status NOT IN ('pending','picked','correct','out_of_stock','cancelled','returned')
     OR (w.status='correct' AND coalesce(m.net_deducted,0)<coalesce(w.qty,0))
     OR (w.status='cancelled' AND w.stock_action IS NULL AND w.status_before_cancel IS NULL)
     OR (w.status='returned' AND coalesce(m.net_deducted,0)>0)
     THEN 1 ELSE 0 END AS uncertain
 FROM public.wms_orders w JOIN products p ON upper(btrim(p.product_code))=upper(btrim(w.product_code))
 LEFT JOIN LATERAL (
   SELECT coalesce(sum(-sm.qty),0) AS net_deducted FROM public.inv_stock_movements sm
   WHERE sm.ref_type='wms_orders' AND sm.ref_id=w.id AND sm.product_id=p.id
     AND sm.movement_type IN ('pick','pick_reversal','return_pick')
 ) m ON true
), wms_totals AS (
 SELECT w.product_id,sum(w.held) AS held,sum(w.uncertain)::bigint AS uncertain,
   count(*) FILTER(WHERE w.status='correct' AND w.qty>0 AND w.net_deducted>=w.qty) AS completed,
   coalesce(jsonb_agg(jsonb_build_object('wms_id',w.id,'work_order',w.order_id,'qty',w.qty,
     'status',w.status,'net_deducted',w.net_deducted,'uncertain',w.uncertain)), '[]'::jsonb) AS evidence
 FROM wms w GROUP BY w.product_id
), documents AS (
 SELECT r.product_id,sum(r.qty) AS held,
   count(*) FILTER(WHERE (r.source_type='order' AND o.id IS NULL) OR (r.source_type='prebill' AND d.id IS NULL)
     OR (r.source_type='prebill' AND (d.status IN ('draft','cancelled','converted','expired') OR d.valid_until<timezone('Asia/Bangkok',now())::date))
     OR (r.source_type='order' AND o.status IN ('ยกเลิก','จัดส่งแล้ว'))) AS uncertain
 FROM public.inv_document_reservations r
 LEFT JOIN public.or_orders o ON r.source_type='order' AND o.id=r.source_id
 LEFT JOIN public.or_prebill_documents d ON r.source_type='prebill' AND d.id=r.source_id
 WHERE r.qty>0 GROUP BY r.product_id
), borrows AS (
 SELECT i.product_id,
   sum(CASE WHEN b.status IN ('approved','partial_returned','overdue')
     THEN greatest(i.qty-coalesce(i.returned_qty,0)-coalesce(i.written_off_qty,0),0) ELSE 0 END) AS held,
   count(*) FILTER(WHERE b.status IS NULL OR b.status NOT IN ('pending','approved','partial_returned','overdue','returned','written_off','cancelled','rejected')
     OR i.qty<0 OR coalesce(i.returned_qty,0)+coalesce(i.written_off_qty,0)>i.qty) AS uncertain
 FROM public.wms_borrow_requisition_items i JOIN public.wms_borrow_requisitions b ON b.id=i.borrow_requisition_id
 GROUP BY i.product_id
), amounts AS (
 SELECT p.id AS product_id,p.product_code,p.product_name,p.unit_name,coalesce(b.on_hand,0) AS on_hand,
   coalesce(b.reserved,0) AS reserved,coalesce(d.held,0) AS document_reserved,
   coalesce(w.held,0) AS wms_reserved,coalesce(br.held,0) AS borrow_reserved,
   coalesce(d.held,0)+coalesce(w.held,0)+coalesce(br.held,0) AS linked_reserved,
   coalesce(w.completed,0) AS completed_wms_count,
   coalesce(w.uncertain,0)+coalesce(d.uncertain,0)+coalesce(br.uncertain,0)+CASE WHEN p.code_count>1 THEN 1 ELSE 0 END AS uncertain_count,
   coalesce(w.evidence,'[]'::jsonb) AS wms_evidence
 FROM products p JOIN public.inv_stock_balances b ON b.product_id=p.id
 LEFT JOIN documents d ON d.product_id=p.id LEFT JOIN wms_totals w ON w.product_id=p.id
 LEFT JOIN borrows br ON br.product_id=p.id
 WHERE p_product_ids IS NULL OR p.id=ANY(p_product_ids)
)
SELECT a.product_id,a.product_code,a.product_name,a.unit_name,a.on_hand,a.reserved,
 a.document_reserved,a.wms_reserved,a.borrow_reserved,a.linked_reserved,a.reserved-a.linked_reserved,
 a.completed_wms_count,a.uncertain_count,
 CASE WHEN a.reserved=a.linked_reserved THEN 'matched'
   WHEN a.uncertain_count>0 THEN 'requires_review'
   WHEN a.reserved<a.linked_reserved THEN 'under_reserved'
   WHEN a.completed_wms_count>0 AND a.linked_reserved<=a.on_hand THEN 'excess_with_completed_evidence'
   ELSE 'unexplained_excess' END,
 jsonb_build_object('wms',a.wms_evidence,'document_reserved',a.document_reserved,'wms_reserved',a.wms_reserved,'borrow_reserved',a.borrow_reserved)
FROM amounts a ORDER BY a.product_code,a.product_id;
$$;
REVOKE ALL ON FUNCTION public.fn_reservation_audit(uuid[]) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.rpc_reconcile_reservation_excess(p_items jsonb,p_reason text)
RETURNS TABLE(batch_id uuid,product_id uuid,product_code text,old_reserved numeric,new_reserved numeric,released_qty numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; a record; v_batch uuid:=gen_random_uuid();
BEGIN
 IF auth.uid() IS NULL THEN
   IF session_user NOT IN ('postgres','supabase_admin') AND NOT pg_has_role(session_user,'postgres','MEMBER') THEN RAISE EXCEPTION 'กรุณาเข้าสู่ระบบ'; END IF;
 ELSIF NOT public.check_user_role(auth.uid(),ARRAY['superadmin','admin','store']) THEN
   RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ยอดจอง' USING ERRCODE='42501';
 END IF;
 IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)=0
    OR nullif(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'ต้องระบุรายการและเหตุผล'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(p_items)) <>
    (SELECT count(DISTINCT (x.value->>'product_id')::uuid) FROM jsonb_array_elements(p_items) x) THEN
   RAISE EXCEPTION 'รายการสินค้าซ้ำหรือไม่มีรหัส';
 END IF;
 -- Locks serialize with all reservation writers; compare with the reviewed snapshot.
 FOR r IN SELECT (x.value->>'product_id')::uuid AS id FROM jsonb_array_elements(p_items) x ORDER BY id LOOP
   PERFORM 1 FROM public.inv_stock_balances b WHERE b.product_id=r.id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบยอดสินค้า %',r.id; END IF;
 END LOOP;
 FOR r IN SELECT x.value AS input FROM jsonb_array_elements(p_items) x ORDER BY x.value->>'product_id' LOOP
   SELECT * INTO STRICT a FROM public.fn_reservation_audit(ARRAY[(r.input->>'product_id')::uuid]);
   IF a.reserved IS DISTINCT FROM (r.input->>'expected_reserved')::numeric
      OR a.linked_reserved IS DISTINCT FROM (r.input->>'expected_linked_reserved')::numeric THEN
     RAISE EXCEPTION 'ยอดเปลี่ยนหลังตรวจ กรุณาตรวจใหม่: %',a.product_code;
   END IF;
   IF a.classification<>'excess_with_completed_evidence' THEN
     RAISE EXCEPTION 'หลักฐานไม่ครบหรือไม่ใช่ยอดจองส่วนเกิน: % (%)',a.product_code,a.classification;
   END IF;
   INSERT INTO public.inv_reservation_reconciliations(batch_id,product_id,old_reserved,new_reserved,reason,evidence)
   VALUES(v_batch,a.product_id,a.reserved,a.linked_reserved,p_reason,a.evidence);
   UPDATE public.inv_stock_balances b SET reserved=a.linked_reserved,updated_at=now() WHERE b.product_id=a.product_id;
   batch_id:=v_batch; product_id:=a.product_id; product_code:=a.product_code;
   old_reserved:=a.reserved; new_reserved:=a.linked_reserved; released_qty:=a.reserved-a.linked_reserved;
   RETURN NEXT;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.rpc_reconcile_reservation_excess(jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_reconcile_reservation_excess(jsonb,text) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
