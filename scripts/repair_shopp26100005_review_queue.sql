-- Restore only the confirmed stranded bill; do not alter money or slips.
BEGIN;
UPDATE public.or_orders o
SET status = 'รอตรวจคำสั่งซื้อ'
WHERE o.id = '0599b759-237d-42af-a4db-4249e70fe4b1'
  AND o.bill_no = 'SHOPP26100005'
  AND o.channel_code = 'SHOPP'
  AND o.status = 'ตรวจสอบแล้ว'
  AND o.requires_confirm_design = FALSE
  AND o.fulfillment_method = 'self_pickup'
  AND o.work_order_id IS NULL
  AND o.admin_user = 'Ta_AM_TR'
  AND EXISTS (SELECT 1 FROM public.us_users u
              WHERE (u.username = o.admin_user OR u.email = o.admin_user)
                AND u.role = 'sales-tr')
RETURNING o.bill_no, o.status, o.requires_confirm_design, o.work_order_id;
COMMIT;
