-- ผู้ที่ได้รับสิทธิ์ Assign ราย User สามารถเห็นและจัดการคิว "งานใหม่"
-- โดยไม่ต้องเปิด marketplace-new ให้ทั้ง role

BEGIN;

CREATE OR REPLACE FUNCTION public.mp_can_manage_new_orders()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.us_users AS u
    LEFT JOIN public.st_user_menus AS menu
      ON menu.role = u.role
     AND menu.menu_key = 'marketplace-new'
    WHERE u.id = auth.uid()
      AND u.is_active = TRUE
      AND u.role <> 'sales-pump'
      AND (
        u.role = 'superadmin'
        OR COALESCE(menu.has_access, FALSE)
        OR public.mp_can_assign_orders()
      )
  );
$$;

REVOKE ALL ON FUNCTION public.mp_can_manage_new_orders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mp_can_manage_new_orders() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
