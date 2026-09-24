-- Read-only audit. Run before repairing; source-less legacy rows require manual
-- bill matching and must not be automatically merged by product code.
SELECT wo.id AS work_order_id,wo.work_order_name,o.bill_no,
       oi.id AS order_item_id,oi.product_type,oi.is_detail_row,
       w.id AS wms_order_id,w.product_code,w.product_name,w.qty,w.status,
       w.source_order_item_id
FROM public.wms_orders w
JOIN public.or_work_orders wo ON wo.id=w.work_order_id
LEFT JOIN public.or_order_items oi ON oi.id=w.source_order_item_id
LEFT JOIN public.or_orders o ON o.id=oi.order_id
LEFT JOIN public.pr_products p ON p.id=oi.product_id
WHERE w.status<>'cancelled'
  AND (btrim(coalesce(w.product_name,'')) LIKE 'ตรายางคอนโด%'
    OR upper(btrim(coalesce(p.product_category,''))) IN ('CONDO STAMP 2FL','CONDO STAMP 3FL','CONDO STAMP 5FL'))
ORDER BY wo.work_order_name,o.bill_no,oi.product_type,w.id;

-- After migration 608, an authenticated superadmin can repair a verified work
-- order with rpc_repair_wms_detail_rows(work_order_id). This uses the existing
-- audited void flow to reverse stock, and is safe to retry. Reconcile spare-part
-- totals separately if the affected product has rubber_code configured.
