-- Claim bills are new shipments. They must not inherit the shipped timestamp
-- from the delivered reference order, otherwise the normal bill-edit guard
-- treats a newly-created REQ bill as already shipped and locks it immediately.

BEGIN;

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
    NEW.shipped_time := NULL;
    NEW.shipped_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Repair existing REQ bills only when their shipped timestamp is the exact
-- timestamp copied from the reference bill and the REQ bill is not shipped.
UPDATE public.or_orders claim_order
SET shipped_time = NULL,
    shipped_by = NULL,
    updated_at = NOW()
FROM public.or_claim_requests claim_request
JOIN public.or_orders reference_order
  ON reference_order.id = claim_request.ref_order_id
WHERE claim_request.created_claim_order_id = claim_order.id
  AND upper(COALESCE(claim_order.bill_no, '')) LIKE 'REQ%'
  AND claim_order.status IS DISTINCT FROM 'จัดส่งแล้ว'
  AND claim_order.shipped_time IS NOT NULL
  AND claim_order.shipped_time = reference_order.shipped_time;

COMMENT ON FUNCTION public.clear_initial_claim_order_tracking_number() IS
  'Clears inherited shipment state when creating a REQ claim bill so normal edit eligibility applies.';

COMMIT;
