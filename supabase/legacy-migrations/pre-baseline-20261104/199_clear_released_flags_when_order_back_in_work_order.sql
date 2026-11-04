-- 199: Cleanup stale "released from work order" flags
-- If an order is currently in a work order (work_order_id is not null),
-- it should not keep plan_released_from_* flags from an older cycle.

UPDATE or_orders
SET
  plan_released_from_work_order = NULL,
  plan_released_from_work_order_id = NULL,
  plan_released_at = NULL
WHERE work_order_id IS NOT NULL
  AND (
    plan_released_from_work_order IS NOT NULL
    OR plan_released_from_work_order_id IS NOT NULL
    OR plan_released_at IS NOT NULL
  );

