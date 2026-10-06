-- Read-only audit. Run before rollout; never automatically rewrite historical paid bills.
-- 1. Pickup bills with shipping charges or saved delivery address.
-- A stored shipping fee is not proof of extra collection: inspect its compensating discount.
-- Never remove shipping alone from an old bill with a matching offset discount.
SELECT o.id,o.bill_no,o.channel_code,o.status,o.price,o.shipping_cost,o.discount,o.total_amount,
       coalesce(o.price,0)+coalesce(o.shipping_cost,0)-coalesce(o.discount,0) AS expected_total,
       o.total_amount-(coalesce(o.price,0)+coalesce(o.shipping_cost,0)-coalesce(o.discount,0)) AS total_difference,
       CASE
         WHEN coalesce(o.shipping_cost,0)>0 AND coalesce(o.discount,0)>=o.shipping_cost
              AND abs(o.total_amount-(coalesce(o.price,0)+o.shipping_cost-coalesce(o.discount,0)))<0.01
           THEN 'ส่วนลดครอบคลุมค่าส่ง และยอดสุทธิตรงสูตร — ตรวจเหตุผลส่วนลดประกอบ'
         WHEN coalesce(o.shipping_cost,0)>0 THEN 'ต้องตรวจส่วนลดและยอดสุทธิ'
         ELSE 'ตรวจที่อยู่จัดส่งที่ค้างอยู่'
       END AS audit_result,
       o.customer_address,o.billing_details->>'address_line' AS address_line
FROM public.or_orders o
WHERE o.fulfillment_method='self_pickup' AND o.status<>'ยกเลิก'
  AND (coalesce(o.shipping_cost,0)<>0 OR nullif(btrim(o.customer_address),'') IS NOT NULL
       OR nullif(btrim(o.billing_details->>'address_line'),'') IS NOT NULL)
ORDER BY o.bill_no;

-- 2. Legacy pickup-to-shipping conversions requiring accounting review.
-- Zero shipping on these old records has no approval in the new workflow.
WITH receipts AS (
 SELECT order_id,sum(amount) paid FROM (
   SELECT order_id,easyslip_trans_ref,max(verified_amount) amount
   FROM public.ac_verified_slips
   WHERE validation_status='passed' AND coalesce(is_deleted,false)=false AND easyslip_trans_ref IS NOT NULL
   GROUP BY order_id,easyslip_trans_ref
 ) s GROUP BY order_id
), refunds AS (
 SELECT order_id,sum(amount) amount FROM public.ac_refunds WHERE status IN ('pending','approved') GROUP BY order_id
)
SELECT o.id,o.bill_no,o.channel_code,o.status,o.converted_from_self_pickup_at,
       o.converted_from_self_pickup_by,o.shipping_cost,o.total_amount,
       greatest(0,coalesce(r.paid,0)-coalesce(f.amount,0)) AS net_verified_payment,
       CASE WHEN coalesce(o.shipping_cost,0)=0 THEN 'ตรวจเหตุผลค่าส่ง 0 และอนุมัติย้อนหลัง'
            ELSE 'ตรวจยอดชำระให้ครบรวมค่าส่ง' END AS review_action
FROM public.or_orders o
LEFT JOIN receipts r ON r.order_id=o.id
LEFT JOIN refunds f ON f.order_id=o.id
WHERE o.fulfillment_method='shipping' AND o.converted_from_self_pickup_at IS NOT NULL
  AND o.status<>'ยกเลิก'
  AND (coalesce(o.shipping_cost,0)=0 OR greatest(0,coalesce(r.paid,0)-coalesce(f.amount,0))<o.total_amount)
ORDER BY o.converted_from_self_pickup_at DESC;
