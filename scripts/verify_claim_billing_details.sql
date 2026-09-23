-- Run after migration 606. Pure function checks; no order records are changed.
BEGIN;
DO $$
DECLARE
  v_legacy JSONB := 'null'::jsonb || jsonb_build_object('mobile_phone', '0812345678');
BEGIN
  ASSERT jsonb_typeof(v_legacy) = 'array', 'Reproduce JSON-null concatenation';
  ASSERT public.normalize_claim_billing_details(v_legacy)->>'mobile_phone' = '0812345678', 'Recover confirmed phone';
  ASSERT public.normalize_claim_billing_details(v_legacy || jsonb_build_object('mobile_phone', '0891234567'))->>'mobile_phone' = '0891234567', 'Latest confirmation wins';
  ASSERT public.normalize_claim_billing_details(NULL) = '{}'::jsonb, 'SQL null';
  ASSERT public.normalize_claim_billing_details('null'::jsonb) = '{}'::jsonb, 'JSON null';
  ASSERT public.normalize_claim_billing_details('{"mobile_phone":"0812345678","postal_code":"40000"}'::jsonb)
    = '{"mobile_phone":"0812345678","postal_code":"40000"}'::jsonb, 'Preserve normal objects';
END;
$$;
ROLLBACK;
