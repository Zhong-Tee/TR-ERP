-- A stale Confirm page can still attempt the former automatic transition
-- "จัดส่งแล้ว" -> "เสร็จสิ้น" after migrations 367/368 restore the rows.
-- At the database boundary, an order with shipped_time is already shipped and
-- must retain the canonical terminal status "จัดส่งแล้ว".

CREATE OR REPLACE FUNCTION public.tr_guard_shipped_order_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.shipped_time IS NOT NULL AND NEW.status = 'เสร็จสิ้น' THEN
    NEW.status := 'จัดส่งแล้ว';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_guard_shipped_order_status ON public.or_orders;

CREATE TRIGGER tr_guard_shipped_order_status
BEFORE INSERT OR UPDATE OF status, shipped_time
ON public.or_orders
FOR EACH ROW
EXECUTE FUNCTION public.tr_guard_shipped_order_status();

-- Restore any rows reverted by a stale client after migrations 367/368 ran.
UPDATE public.or_orders
SET status = 'จัดส่งแล้ว'
WHERE status = 'เสร็จสิ้น'
  AND shipped_time IS NOT NULL;
