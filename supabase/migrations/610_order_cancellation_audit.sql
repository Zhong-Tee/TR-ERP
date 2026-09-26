-- Record the actor for every full bill cancellation, regardless of whether the
-- status change comes from the order form, waiting list, or amendment workflow.

ALTER TABLE public.or_orders
  ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES public.us_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancelled_by_name TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

COMMENT ON COLUMN public.or_orders.cancelled_by IS
  'Authenticated user who most recently changed the bill status to ยกเลิก';
COMMENT ON COLUMN public.or_orders.cancelled_by_name IS
  'Username/email snapshot of the user who cancelled the bill';
COMMENT ON COLUMN public.or_orders.cancelled_at IS
  'Time when the bill was most recently changed to ยกเลิก';

CREATE OR REPLACE FUNCTION public.capture_order_cancellation_actor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id UUID := auth.uid();
  v_actor_name TEXT;
BEGIN
  IF NEW.status = 'ยกเลิก' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF v_actor_id IS NOT NULL THEN
      SELECT COALESCE(NULLIF(BTRIM(username), ''), NULLIF(BTRIM(email), ''), v_actor_id::TEXT)
      INTO v_actor_name
      FROM public.us_users
      WHERE id = v_actor_id;

      NEW.cancelled_by := v_actor_id;
    END IF;

    NEW.cancelled_by_name := COALESCE(
      v_actor_name,
      NULLIF(BTRIM(NEW.cancelled_by_name), ''),
      NULLIF(BTRIM(OLD.cancelled_by_name), ''),
      CASE WHEN NEW.cancelled_by IS NOT NULL THEN NEW.cancelled_by::TEXT END
    );
    NEW.cancelled_at := NOW();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_capture_order_cancellation_actor ON public.or_orders;
CREATE TRIGGER trg_capture_order_cancellation_actor
BEFORE UPDATE OF status ON public.or_orders
FOR EACH ROW
EXECUTE FUNCTION public.capture_order_cancellation_actor();

-- Repair historical full cancellations that went through the approved
-- amendment workflow. This is the only historical source with an attributable
-- cancellation actor; direct legacy cancellations intentionally remain blank.
WITH latest_full_cancellation AS (
  SELECT DISTINCT ON (a.order_id)
    a.order_id,
    a.approved_by,
    a.executed_at,
    COALESCE(NULLIF(BTRIM(u.username), ''), NULLIF(BTRIM(u.email), ''), a.approved_by::TEXT) AS actor_name
  FROM public.or_order_amendments a
  LEFT JOIN public.us_users u ON u.id = a.approved_by
  WHERE a.status = 'executed'
    AND a.approved_by IS NOT NULL
    AND NOT (COALESCE(a.changes_json, '{}'::JSONB) ? 'remove_item_ids')
    AND jsonb_array_length(COALESCE(a.items_after, '[]'::JSONB)) = 0
  ORDER BY a.order_id, a.executed_at DESC NULLS LAST, a.created_at DESC
)
UPDATE public.or_orders o
SET cancelled_by = COALESCE(o.cancelled_by, c.approved_by),
    cancelled_by_name = COALESCE(NULLIF(BTRIM(o.cancelled_by_name), ''), c.actor_name),
    cancelled_at = COALESCE(o.cancelled_at, c.executed_at, o.updated_at)
FROM latest_full_cancellation c
WHERE o.id = c.order_id
  AND o.status = 'ยกเลิก'
  AND c.executed_at BETWEEN o.updated_at - INTERVAL '5 minutes' AND o.updated_at + INTERVAL '5 minutes';

CREATE INDEX IF NOT EXISTS idx_or_orders_cancelled_by
  ON public.or_orders(cancelled_by)
  WHERE cancelled_by IS NOT NULL;

NOTIFY pgrst, 'reload schema';
