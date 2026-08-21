BEGIN;

-- Restore every work-order header that still owns active bills. Migration 408's
-- first revision could have finalized these headers because it relied on stale
-- links/statuses; active child bills are the authoritative source for recovery.
UPDATE public.or_work_orders wo
SET status = 'กำลังผลิต',
    order_count = active_orders.active_count,
    plan_wo_modified = true
FROM (
  SELECT o.work_order_id, count(*)::INTEGER AS active_count
  FROM public.or_orders o
  WHERE o.work_order_id IS NOT NULL
    AND COALESCE(o.status, '') NOT IN ('ยกเลิก', 'จัดส่งแล้ว')
  GROUP BY o.work_order_id
) active_orders
WHERE wo.id = active_orders.work_order_id
  AND (
    wo.status IS DISTINCT FROM 'กำลังผลิต'
    OR wo.order_count IS DISTINCT FROM active_orders.active_count
  );

-- Keep the legacy name link used by Packing consistent with the canonical UUID.
UPDATE public.or_orders o
SET work_order_name = wo.work_order_name
FROM public.or_work_orders wo
WHERE o.work_order_id = wo.id
  AND COALESCE(o.status, '') NOT IN ('ยกเลิก', 'จัดส่งแล้ว')
  AND o.work_order_name IS DISTINCT FROM wo.work_order_name;

COMMIT;
