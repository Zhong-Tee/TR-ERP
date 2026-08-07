-- Migration 345 may already have been applied before draft documents were
-- included in the employee acknowledgement flow. Recreate both RPCs so an
-- existing environment receives the updated rules.

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
    RAISE EXCEPTION 'ไม่พบใบเตือน หรือใบเตือนนี้รับทราบแล้ว';
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
    RAISE EXCEPTION 'ไม่พบใบรับรอง หรือใบรับรองนี้รับทราบแล้ว';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.acknowledge_my_warning(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.acknowledge_my_certificate(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acknowledge_my_warning(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acknowledge_my_certificate(UUID) TO authenticated;
