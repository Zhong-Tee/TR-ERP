-- Read-only: run AFTER migration 626 in SQL Editor. This changes no stock.
SELECT * FROM public.fn_reservation_audit(NULL)
WHERE difference<>0 ORDER BY classification,product_code;

-- Summary by review category, preserving product units (never total mixed units).
SELECT classification,unit_name,count(*) AS product_count,
       sum(greatest(difference,0)) AS excess_reserved,
       sum(greatest(-difference,0)) AS missing_reserved
FROM public.fn_reservation_audit(NULL) WHERE difference<>0
GROUP BY classification,unit_name ORDER BY classification,unit_name;

-- Changes actually performed (empty until explicitly corrected).
SELECT h.batch_id,p.product_code,p.product_name,p.unit_name,
       h.old_reserved,h.new_reserved,h.old_reserved-h.new_reserved AS released_qty,
       h.reason,h.created_at
FROM public.inv_reservation_reconciliations h
JOIN public.pr_products p ON p.id=h.product_id ORDER BY h.created_at DESC,p.product_code;
