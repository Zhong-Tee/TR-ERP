-- ============================================================
-- 252: Block inactive users at database level via RLS
-- ใช้ SECURITY DEFINER function เพื่อป้องกัน infinite recursion
-- เมื่อ user มี is_active = FALSE จะมองไม่เห็นแถวตัวเองใน us_users
-- ทำให้ EXISTS check ในทุกตาราง return false → blocked ทั้งระบบ
-- ============================================================

-- Function ตรวจสอบ is_active ของ current user
-- SECURITY DEFINER = bypass RLS เพื่อป้องกัน recursive policy
CREATE OR REPLACE FUNCTION public.is_current_user_active()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT COALESCE(
    (SELECT is_active FROM public.us_users WHERE id = auth.uid()),
    FALSE
  );
$$;

-- อัปเดต SELECT policy บน us_users ให้บล็อค inactive users
DROP POLICY IF EXISTS "Admins can view all users" ON public.us_users;
CREATE POLICY "Admins can view all users"
  ON public.us_users FOR SELECT
  USING (
    public.is_current_user_active() AND (
      auth.uid() = id OR
      check_user_role(auth.uid(), ARRAY['superadmin', 'sales-tr'])
    )
  );
