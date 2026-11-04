-- Warehouse location and transfer management:
-- allow account and remove sales-tr.

BEGIN;

CREATE OR REPLACE FUNCTION public.can_manage_warehouse_locations()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.us_users
    WHERE id = auth.uid()
      AND role IN ('superadmin', 'admin', 'account', 'store')
  );
$$;

REVOKE ALL ON FUNCTION public.can_manage_warehouse_locations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_manage_warehouse_locations() TO authenticated;

COMMENT ON FUNCTION public.can_manage_warehouse_locations() IS
  'Allows superadmin, admin, account and store to manage storage locations and stock transfers.';

COMMIT;
