-- Claim snapshots can contain JSON null (different from SQL NULL).
-- COALESCE(JSON 'null', '{}') remains JSON null; concatenating the confirmed
-- phone then creates [null, {mobile_phone: ...}], invisible to ->> lookups.
BEGIN;

CREATE OR REPLACE FUNCTION public.normalize_claim_billing_details(p_details JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_result JSONB := '{}'::jsonb;
  v_part JSONB;
BEGIN
  IF jsonb_typeof(p_details) = 'object' THEN
    RETURN p_details;
  END IF;
  IF jsonb_typeof(p_details) = 'array' THEN
    FOR v_part IN SELECT value FROM jsonb_array_elements(p_details) WITH ORDINALITY AS parts(value, seq) ORDER BY seq
    LOOP
      IF jsonb_typeof(v_part) = 'object' THEN
        v_result := v_result || v_part;
      END IF;
    END LOOP;
  END IF;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.or_orders_normalize_claim_billing_details()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.bill_no LIKE 'REQ%' THEN
    NEW.billing_details := public.normalize_claim_billing_details(NEW.billing_details);
  END IF;
  RETURN NEW;
END;
$$;

-- Run before the existing trg_99_strip_original_customer_address cleanup.
DROP TRIGGER IF EXISTS trg_98_normalize_claim_billing_details ON public.or_orders;
CREATE TRIGGER trg_98_normalize_claim_billing_details
BEFORE INSERT OR UPDATE OF billing_details ON public.or_orders
FOR EACH ROW EXECUTE FUNCTION public.or_orders_normalize_claim_billing_details();

-- Recover only values already stored on each claim, never another bill's phone.
-- Rightmost object wins, matching successive shipping confirmations.
UPDATE public.or_orders
SET billing_details = public.normalize_claim_billing_details(billing_details)
WHERE bill_no LIKE 'REQ%'
  AND jsonb_typeof(billing_details) IN ('array', 'null');

COMMIT;
