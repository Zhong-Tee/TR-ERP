-- Requisition approval/rejection is limited to superadmin, admin and store.

BEGIN;

INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access)
VALUES ('store', 'warehouse-requisition-approval', 'อนุมัติใบเบิก', true)
ON CONFLICT (role, menu_key)
DO UPDATE SET
  menu_name = EXCLUDED.menu_name,
  has_access = EXCLUDED.has_access,
  updated_at = now();

CREATE OR REPLACE FUNCTION public.guard_wms_requisition_approval_roles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status
     AND NEW.status IN ('approved', 'rejected') THEN
    SELECT u.role
      INTO v_role
    FROM public.us_users AS u
    WHERE u.id = auth.uid()
      AND u.is_active IS TRUE;

    IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'store') THEN
      RAISE EXCEPTION 'Not authorized to approve or reject requisitions';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
