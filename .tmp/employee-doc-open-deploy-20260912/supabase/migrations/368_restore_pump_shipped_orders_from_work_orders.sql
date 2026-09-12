-- Migration 367 intentionally restored only rows that already had shipped_time.
-- Some legacy PUMP rows lost the order-level shipped status without ever receiving
-- shipped_time, while their related work order correctly remained "จัดส่งแล้ว".
-- Use that shipped work order as the recovery source and restore both fields so
-- the Orders > จัดส่งแล้ว date filter can find the rows.
UPDATE public.or_orders AS orders
SET
  status = 'จัดส่งแล้ว',
  shipped_time = COALESCE(orders.shipped_time, shipped_wo.updated_at, orders.updated_at, NOW())
FROM public.or_work_orders AS shipped_wo
WHERE orders.channel_code = 'PUMP'
  AND orders.status = 'เสร็จสิ้น'
  AND orders.work_order_id = shipped_wo.id
  AND shipped_wo.status = 'จัดส่งแล้ว';
