-- Preserve the matched Marketplace shipping-rule requirement on the bill so
-- Account > Bill edit can show the express receipt field only when applicable.

ALTER TABLE public.or_orders
  ADD COLUMN IF NOT EXISTS requires_express_receipt_number BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.or_orders.requires_express_receipt_number IS
  'True when the Marketplace shipping rule requires an express parcel receipt number.';

-- Backfill bills already opened from Marketplace using the direct relation.
UPDATE public.or_orders o
SET requires_express_receipt_number = TRUE
FROM public.mp_orders m
WHERE m.billed_order_id = o.id
  AND m.requires_express_receipt_number = TRUE
  AND o.requires_express_receipt_number = FALSE;

-- A stored number is also conclusive evidence that the field applies. This
-- keeps legacy bills editable even if their Marketplace link is unavailable.
UPDATE public.or_orders
SET requires_express_receipt_number = TRUE
WHERE NULLIF(btrim(COALESCE(express_receipt_number, '')), '') IS NOT NULL
  AND requires_express_receipt_number = FALSE;
