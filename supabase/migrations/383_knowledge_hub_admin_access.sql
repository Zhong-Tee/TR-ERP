-- Allow both superadmin and admin to manage Knowledge Hub.

CREATE OR REPLACE FUNCTION public.kb_is_superadmin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid()
      AND role IN ('superadmin', 'admin')
      AND COALESCE(is_active, true) = true
  );
$$;

INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access)
VALUES ('admin', 'knowledge-hub', 'Knowledge Hub', true)
ON CONFLICT (role, menu_key) DO UPDATE
SET menu_name = EXCLUDED.menu_name, has_access = true, updated_at = now();

