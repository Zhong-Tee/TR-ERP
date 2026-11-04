-- The raw address snapshot could remain from an earlier paste while the
-- reviewed structured shipping fields were updated. Remove it and prevent all
-- write paths (including older RPCs/clients) from storing it again.
CREATE OR REPLACE FUNCTION public.or_orders_strip_original_customer_address()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.billing_details IS NOT NULL
     AND NEW.billing_details ? 'original_customer_address' THEN
    NEW.billing_details := NEW.billing_details - 'original_customer_address';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_99_strip_original_customer_address ON public.or_orders;
CREATE TRIGGER trg_99_strip_original_customer_address
BEFORE INSERT OR UPDATE OF billing_details
ON public.or_orders
FOR EACH ROW
EXECUTE FUNCTION public.or_orders_strip_original_customer_address();

UPDATE public.or_orders
SET billing_details = billing_details - 'original_customer_address'
WHERE billing_details ? 'original_customer_address';

COMMENT ON FUNCTION public.or_orders_strip_original_customer_address() IS
  'Prevents stale raw address snapshots from being stored in billing_details.';
