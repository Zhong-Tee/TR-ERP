ALTER TABLE public.hr_warnings
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

ALTER TABLE public.hr_certificates
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.acknowledge_my_warning(p_warning_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.hr_warnings
  SET status = 'acknowledged', acknowledged_at = COALESCE(acknowledged_at, now())
  WHERE id = p_warning_id
    AND employee_id = public.hr_my_employee_id()
    AND status NOT IN ('acknowledged', 'resolved');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warning not found or cannot be acknowledged';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.acknowledge_my_certificate(p_certificate_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.hr_certificates
  SET acknowledged_at = COALESCE(acknowledged_at, now())
  WHERE id = p_certificate_id
    AND employee_id = public.hr_my_employee_id()
    AND acknowledged_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Certificate not found or cannot be acknowledged';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.acknowledge_my_warning(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.acknowledge_my_certificate(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acknowledge_my_warning(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acknowledge_my_certificate(UUID) TO authenticated;
