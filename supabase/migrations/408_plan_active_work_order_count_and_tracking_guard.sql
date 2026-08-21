BEGIN;

-- The Plan badge represents work orders that still contain at least one active bill,
-- not stale work-order headers whose status was never finalized.
CREATE OR REPLACE FUNCTION public.rpc_plan_active_work_order_count()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(DISTINCT o.work_order_id)
  FROM public.or_orders o
  WHERE o.work_order_id IS NOT NULL
    AND COALESCE(o.status, '') NOT IN ('ยกเลิก', 'จัดส่งแล้ว');
$$;

GRANT EXECUTE ON FUNCTION public.rpc_plan_active_work_order_count() TO authenticated;

-- UI validation already rejects duplicate tracking numbers. This database guard
-- closes concurrent/API write paths while preserving legacy duplicates for audit.
CREATE OR REPLACE FUNCTION public.guard_unique_order_tracking_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_tracking TEXT;
BEGIN
  v_tracking := NULLIF(btrim(NEW.tracking_number), '');
  NEW.tracking_number := v_tracking;

  IF TG_OP = 'UPDATE'
     AND NULLIF(btrim(OLD.tracking_number), '') IS NOT DISTINCT FROM v_tracking THEN
    RETURN NEW;
  END IF;

  IF v_tracking IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.or_orders other
    WHERE other.id IS DISTINCT FROM NEW.id
      AND upper(btrim(other.tracking_number)) = upper(v_tracking)
  ) THEN
    RAISE EXCEPTION 'เลขพัสดุ % ซ้ำกับบิลอื่นในระบบ', v_tracking;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_unique_order_tracking_number ON public.or_orders;
CREATE TRIGGER trg_guard_unique_order_tracking_number
BEFORE INSERT OR UPDATE OF tracking_number ON public.or_orders
FOR EACH ROW
WHEN (NEW.tracking_number IS NOT NULL)
EXECUTE FUNCTION public.guard_unique_order_tracking_number();

COMMIT;
