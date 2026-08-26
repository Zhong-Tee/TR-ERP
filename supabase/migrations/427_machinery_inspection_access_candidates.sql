-- Allow Machinery administrators to load only the user fields needed by the
-- per-machine inspection access picker without granting broad SELECT access
-- to public.us_users.
BEGIN;

CREATE OR REPLACE FUNCTION public.get_machinery_inspection_access_candidates()
RETURNS TABLE (
  id uuid,
  username text,
  email text,
  role text,
  is_active boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    candidate.id,
    candidate.username,
    candidate.email,
    candidate.role,
    candidate.is_active
  FROM public.us_users AS candidate
  WHERE public.check_user_role(
      auth.uid(),
      ARRAY['superadmin', 'admin', 'technician']
    )
    AND candidate.role IN ('production', 'production_mb', 'manager', 'packing_staff')
    AND candidate.is_active = true
  ORDER BY candidate.username NULLS LAST, candidate.email NULLS LAST;
$$;

REVOKE ALL ON FUNCTION public.get_machinery_inspection_access_candidates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_machinery_inspection_access_candidates() TO authenticated;

COMMIT;
