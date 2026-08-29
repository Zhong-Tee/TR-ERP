-- จำกัดผู้มอบหมายงาน Marketplace และคืนสิทธิ์บันทึกร่างให้ผู้รับงาน
--
-- 1) ผู้ที่ Assign/เปลี่ยนผู้รับผิดชอบได้: superadmin, admin, sales-tr
-- 2) ผู้รับงาน sales-tr / sales-pump เพิ่มรายการร่างที่เกิดจากการแยกสินค้า
--    หรือเพิ่มของแถมได้ เพื่อให้ saveDrafts ก่อนเปิดบิลไม่ติด RLS

BEGIN;

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
      AND u.role IN ('superadmin', 'admin', 'sales-tr')
  );
$$;

REVOKE ALL ON FUNCTION public.mp_can_assign_orders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mp_can_assign_orders() TO authenticated;

-- แยกสิทธิ์ Assign ออกจากสิทธิ์เข้าเมนู marketplace-new เพื่อไม่ให้ role อื่น
-- ที่ได้รับสิทธิ์เข้าเมนูสามารถมอบหมายงานผ่าน API ได้โดยอัตโนมัติ
DROP POLICY IF EXISTS mp_orders_update ON public.mp_orders;

CREATE POLICY mp_orders_update ON public.mp_orders
  FOR UPDATE TO authenticated
  USING (
    public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
    OR (public.mp_can_manage_new_orders() AND status = 'new')
    OR (
      public.mp_can_assign_orders()
      AND (
        status = 'new'
        OR assigned_by = auth.uid()
        OR assigned_to = auth.uid()
      )
    )
    OR (
      assigned_to = auth.uid()
      AND public.check_user_role(auth.uid(), ARRAY['sales-tr', 'sales-pump'])
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
      AND public.check_user_role(auth.uid(), ARRAY['sales-tr', 'sales-pump'])
    )
  );

-- migration 441 เคยเขียน policy นี้ทับและเหลือเฉพาะรายการของ order สถานะ new
-- จึงต้องคืน branch ของผู้รับงาน เพื่อรองรับแถวใหม่ที่ saveDrafts สร้างก่อนเปิดบิล
DROP POLICY IF EXISTS mp_items_insert ON public.mp_order_items;

CREATE POLICY mp_items_insert ON public.mp_order_items
  FOR INSERT TO authenticated
  WITH CHECK (
    public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
    OR (
      public.mp_can_manage_new_orders()
      AND EXISTS (
        SELECT 1
        FROM public.mp_orders AS o
        WHERE o.id = mp_order_id
          AND o.status = 'new'
      )
    )
    OR EXISTS (
      SELECT 1
      FROM public.mp_orders AS o
      WHERE o.id = mp_order_id
        AND o.assigned_to = auth.uid()
        AND public.check_user_role(auth.uid(), ARRAY['sales-tr', 'sales-pump'])
    )
  );

NOTIFY pgrst, 'reload schema';

COMMIT;
