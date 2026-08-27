-- Claim bills are a new shipment. Keep the original tracking number as
-- immutable request history, but do not reuse it on the newly-created REQ bill.

BEGIN;

-- Backfill original tracking history for existing draft/pending/approved claims.
UPDATE public.or_claim_requests request
SET ref_snapshot = COALESCE(request.ref_snapshot, '{}'::jsonb)
  || jsonb_build_object(
    'tracking_number',
    COALESCE(
      NULLIF(request.ref_snapshot->>'tracking_number', ''),
      NULLIF(request.proposed_snapshot->'order'->>'tracking_number', ''),
      reference_order.tracking_number
    )
  )
FROM public.or_orders reference_order
WHERE reference_order.id = request.ref_order_id
  AND NOT (COALESCE(request.ref_snapshot, '{}'::jsonb) ? 'tracking_number');

CREATE OR REPLACE FUNCTION public.clear_initial_claim_order_tracking_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.claim_type IS NOT NULL
     AND btrim(NEW.claim_type) <> ''
     AND upper(COALESCE(NEW.bill_no, '')) LIKE 'REQ%' THEN
    NEW.tracking_number := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger names of the same timing/event run alphabetically. This must run
-- before trg_guard_unique_order_tracking_number from migration 408.
DROP TRIGGER IF EXISTS trg_00_clear_initial_claim_order_tracking
  ON public.or_orders;
CREATE TRIGGER trg_00_clear_initial_claim_order_tracking
BEFORE INSERT ON public.or_orders
FOR EACH ROW
EXECUTE FUNCTION public.clear_initial_claim_order_tracking_number();

COMMIT;

