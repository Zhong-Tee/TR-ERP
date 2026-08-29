-- สิทธิ์ Assign งาน Marketplace แบบราย User และยกเลิกการเข้าถึงของ sales-pump

BEGIN;

CREATE TABLE IF NOT EXISTS public.mp_assigner_permissions (
  user_id UUID PRIMARY KEY REFERENCES public.us_users(id) ON DELETE CASCADE,
  can_assign BOOLEAN NOT NULL DEFAULT FALSE,
  granted_by UUID REFERENCES public.us_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.mp_assigner_permissions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mp_assigner_permissions TO authenticated;

DROP POLICY IF EXISTS mp_assigner_permissions_select ON public.mp_assigner_permissions;
DROP POLICY IF EXISTS mp_assigner_permissions_write ON public.mp_assigner_permissions;

CREATE POLICY mp_assigner_permissions_select ON public.mp_assigner_permissions
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.check_user_role(auth.uid(), ARRAY['superadmin'])
  );

CREATE POLICY mp_assigner_permissions_write ON public.mp_assigner_permissions
  FOR ALL TO authenticated
  USING (public.check_user_role(auth.uid(), ARRAY['superadmin']))
  WITH CHECK (public.check_user_role(auth.uid(), ARRAY['superadmin']));

-- รักษาสิทธิ์เดิมของ admin/sales-tr ไว้ในครั้งแรก แล้วให้ superadmin
-- เปิดหรือปิดรายบุคคลต่อจากหน้า Marketplace > ตั้งค่า
INSERT INTO public.mp_assigner_permissions (user_id, can_assign)
SELECT id, TRUE
FROM public.us_users
WHERE is_active = TRUE
  AND role IN ('admin', 'sales-tr')
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.mp_can_assign_orders()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.us_users AS u
    WHERE u.id = auth.uid()
      AND u.is_active = TRUE
      AND (
        u.role = 'superadmin'
        OR EXISTS (
          SELECT 1
          FROM public.mp_assigner_permissions AS permission
          WHERE permission.user_id = u.id
            AND permission.can_assign = TRUE
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION public.mp_can_assign_orders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mp_can_assign_orders() TO authenticated;

-- คงการมองเห็นเมนูงานใหม่ตาม st_user_menus แต่ sales-pump ถูกตัดออกถาวร
-- แม้มีผู้เปิดค่าเมนูกลับผ่าน API โดยตรง
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
        u.role IN ('superadmin', 'admin')
        OR COALESCE(menu.has_access, FALSE)
      )
  );
$$;

REVOKE ALL ON FUNCTION public.mp_can_manage_new_orders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mp_can_manage_new_orders() TO authenticated;

-- RLS ไม่สามารถตรวจได้ว่า UPDATE เปลี่ยนเฉพาะคอลัมน์ Assign หรือไม่
-- จึงใช้ trigger ป้องกันการ Assign ผ่าน API สำหรับ User ที่ไม่ได้รับสิทธิ์
CREATE OR REPLACE FUNCTION public.enforce_mp_assign_permission()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND (
       NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
       OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by
       OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
       OR (NEW.status = 'assigned' AND OLD.status IS DISTINCT FROM 'assigned')
     )
     AND NOT public.mp_can_assign_orders()
  THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ Assign งาน Marketplace'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_mp_assign_permission ON public.mp_orders;
CREATE TRIGGER trg_enforce_mp_assign_permission
  BEFORE UPDATE ON public.mp_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_mp_assign_permission();

-- sales-pump ไม่สามารถเปิด Marketplace ได้ แม้เคยเปิดเมนูไว้ใน Role settings
UPDATE public.st_user_menus
SET has_access = FALSE
WHERE role = 'sales-pump'
  AND (menu_key = 'marketplace' OR menu_key LIKE 'marketplace-%');

-- ตัด sales-pump ออกจากข้อมูล Marketplace ที่ระดับฐานข้อมูลด้วย
DROP POLICY IF EXISTS mp_orders_select ON public.mp_orders;
CREATE POLICY mp_orders_select ON public.mp_orders
  FOR SELECT TO authenticated
  USING (
    public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
    OR (
      public.mp_can_manage_new_orders()
      AND status = 'new'
    )
    OR (
      public.mp_can_assign_orders()
      AND assigned_by = auth.uid()
    )
    OR (
      assigned_to = auth.uid()
      AND public.check_user_role(auth.uid(), ARRAY['sales-tr'])
    )
  );

DROP POLICY IF EXISTS mp_orders_insert ON public.mp_orders;
CREATE POLICY mp_orders_insert ON public.mp_orders
  FOR INSERT TO authenticated
  WITH CHECK (
    (
      public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
      AND (
        public.mp_can_assign_orders()
        OR (status = 'new' AND assigned_to IS NULL)
      )
    )
    OR (
      public.mp_can_manage_new_orders()
      AND status = 'new'
      AND assigned_to IS NULL
    )
  );

DROP POLICY IF EXISTS mp_orders_update ON public.mp_orders;
CREATE POLICY mp_orders_update ON public.mp_orders
  FOR UPDATE TO authenticated
  USING (
    public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
    OR (public.mp_can_manage_new_orders() AND status = 'new')
    OR (
      public.mp_can_assign_orders()
      AND (
        (status = 'new' AND public.mp_can_manage_new_orders())
        OR assigned_by = auth.uid()
        OR assigned_to = auth.uid()
      )
    )
    OR (
      assigned_to = auth.uid()
      AND public.check_user_role(auth.uid(), ARRAY['sales-tr'])
    )
  )
  WITH CHECK (
    public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
    OR (
      public.mp_can_manage_new_orders()
      AND status = 'new'
      AND assigned_to IS NULL
    )
    OR (
      public.mp_can_assign_orders()
      AND (
        (status = 'new' AND assigned_to IS NULL)
        OR (
          status IN ('assigned', 'follow_up')
          AND assigned_to IS NOT NULL
          AND assigned_by = auth.uid()
        )
      )
    )
    OR (
      assigned_to = auth.uid()
      AND public.check_user_role(auth.uid(), ARRAY['sales-tr'])
    )
  );

DROP POLICY IF EXISTS mp_items_select ON public.mp_order_items;
CREATE POLICY mp_items_select ON public.mp_order_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.mp_orders AS o
      WHERE o.id = mp_order_id
        AND (
          public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
          OR (
            public.mp_can_manage_new_orders()
            AND o.status = 'new'
          )
          OR (
            public.mp_can_assign_orders()
            AND o.assigned_by = auth.uid()
          )
          OR (
            o.assigned_to = auth.uid()
            AND public.check_user_role(auth.uid(), ARRAY['sales-tr'])
          )
        )
    )
  );

DROP POLICY IF EXISTS mp_items_insert ON public.mp_order_items;
CREATE POLICY mp_items_insert ON public.mp_order_items
  FOR INSERT TO authenticated
  WITH CHECK (
    public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
    OR (
      public.mp_can_manage_new_orders()
      AND EXISTS (
        SELECT 1 FROM public.mp_orders AS o
        WHERE o.id = mp_order_id AND o.status = 'new'
      )
    )
    OR EXISTS (
      SELECT 1 FROM public.mp_orders AS o
      WHERE o.id = mp_order_id
        AND o.assigned_to = auth.uid()
        AND public.check_user_role(auth.uid(), ARRAY['sales-tr'])
    )
  );

DROP POLICY IF EXISTS mp_items_update ON public.mp_order_items;
CREATE POLICY mp_items_update ON public.mp_order_items
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.mp_orders AS o
      WHERE o.id = mp_order_id
        AND (
          public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
          OR (
            o.assigned_to = auth.uid()
            AND public.check_user_role(auth.uid(), ARRAY['sales-tr'])
          )
        )
    )
  );

DROP POLICY IF EXISTS mp_items_delete ON public.mp_order_items;
CREATE POLICY mp_items_delete ON public.mp_order_items
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.mp_orders AS o
      WHERE o.id = mp_order_id
        AND (
          public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
          OR (
            o.assigned_to = auth.uid()
            AND public.check_user_role(auth.uid(), ARRAY['sales-tr'])
          )
        )
    )
  );

NOTIFY pgrst, 'reload schema';

COMMIT;
