-- Read-only: inspect bill routing and manual slip decisions.
SELECT o.id, o.bill_no, o.channel_code, o.status, o.fulfillment_method,
       o.requires_confirm_design, o.admin_user, o.work_order_id,
       o.created_at, o.shipping_conversion_pending,
       u.role AS owner_role
FROM public.or_orders o
LEFT JOIN public.us_users u ON u.username = o.admin_user
WHERE o.bill_no = 'SHOPP26100005';

SELECT m.*
FROM public.ac_manual_slip_checks m
JOIN public.or_orders o ON o.id = m.order_id
WHERE o.bill_no = 'SHOPP26100005';
