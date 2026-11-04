-- Restore orders that were already shipped but were changed to "เสร็จสิ้น"
-- by the Confirm board's former load-time side effect.
-- "เสร็จสิ้น" remains an internal pre-production status, displayed as "ส่งผลิต".
UPDATE public.or_orders
SET status = 'จัดส่งแล้ว'
WHERE status = 'เสร็จสิ้น'
  AND shipped_time IS NOT NULL;
