-- Use saved QT/PC discount lines when available, matching the request totals.
CREATE OR REPLACE FUNCTION public.rpc_discount_approval_queue(p_status text DEFAULT 'pending'::text, p_type text DEFAULT 'all'::text, p_offset integer DEFAULT 0) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE result_ jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.us_users WHERE id=auth.uid() AND is_active AND role='superadmin') THEN RAISE EXCEPTION 'เฉพาะ superadmin เท่านั้น'; END IF;
 WITH rows_ AS (
 SELECT 'sale'::text source,r.id,o.id document_id,o.bill_no document_no,r.requested_name owner_name,r.reason,
 (r.snapshot->>'price')::numeric subtotal,(r.snapshot->>'shipping_cost')::numeric shipping_cost,
 (r.snapshot->>'discount')::numeric discount,(r.snapshot->>'total_amount')::numeric total_amount,r.created_at,
 CASE WHEN o.status='ยกเลิก' THEN 'cancelled' WHEN r.status IN ('pending','approved') AND r.snapshot<>public.or_discount_snapshot(to_jsonb(o),public.or_discount_items(o.id)) THEN 'stale' ELSE r.status END status,
 r.reviewed_name,r.reviewed_at,r.review_note,r.snapshot||jsonb_build_object('items',coalesce((SELECT jsonb_agg(x||jsonb_build_object('product_name',p.product_name)) FROM jsonb_array_elements(r.snapshot->'items') x LEFT JOIN public.pr_products p ON p.id=(x->>'product_id')::uuid),'[]')) snapshot
 FROM public.or_sales_discount_requests r JOIN public.or_orders o ON o.id=r.order_id
 UNION ALL
 SELECT CASE d.document_type WHEN 'quotation' THEN 'QT' ELSE 'PC' END,d.id,d.id,d.document_no,d.owner_name,d.discount_request_note,
 coalesce((d.discount_review_snapshot->>'price')::numeric,d.subtotal),coalesce((d.discount_review_snapshot->>'shipping_cost')::numeric,d.shipping_cost),coalesce((d.discount_review_snapshot->>'discount')::numeric,d.promotion_discount+d.special_discount),coalesce((d.discount_review_snapshot->>'total_amount')::numeric,d.total_amount),coalesce(d.discount_requested_at,d.created_at),
 CASE WHEN d.status='pending_discount' AND d.valid_until>=(now() AT TIME ZONE 'Asia/Bangkok')::date THEN 'pending'
 WHEN d.status IN ('approved','converted') AND d.approved_by IS NOT NULL THEN 'approved'
 WHEN d.status='rejected' THEN 'rejected' WHEN d.status='cancelled' THEN 'cancelled' WHEN d.status='pending_discount' THEN 'expired' ELSE 'stale' END,
 u.username,d.approved_at,coalesce(d.approval_note,d.rejection_note),coalesce(d.discount_review_snapshot,'{}'::jsonb)||jsonb_build_object('items',
 CASE WHEN d.discount_review_snapshot->'items' IS NOT NULL THEN
 coalesce((SELECT jsonb_agg(x||jsonb_build_object('product_name',p.product_name)) FROM jsonb_array_elements(d.discount_review_snapshot->'items') x LEFT JOIN public.pr_products p ON p.id=(x->>'product_id')::uuid),'[]'::jsonb)
 ELSE coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.sort_order) FROM public.or_prebill_items i WHERE document_id=d.id),'[]'::jsonb) END)
 FROM public.or_prebill_documents d LEFT JOIN public.us_users u ON u.id=d.approved_by
 WHERE d.discount_requested_at IS NOT NULL
 ), filtered AS (SELECT * FROM rows_ WHERE (p_status='all' OR status=p_status) AND (p_type='all' OR source=p_type)),
 page AS (SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT 50 OFFSET greatest(0,p_offset))
 SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(to_jsonb(page)) FROM page),'[]'),
 'count',(SELECT count(*) FROM filtered),'pending_count',(SELECT count(*) FROM rows_ WHERE status='pending')) INTO result_;
 RETURN result_;
END $$;
