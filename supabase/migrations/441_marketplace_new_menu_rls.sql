-- Align Marketplace "งานใหม่" database permissions with st_user_menus.
-- Migration 291 intentionally limited imports to admins, but the UI permission
-- can later be granted to another role (for example sales-tr). Without matching
-- RLS policies, those users see the import UI but fail on mp_import_batches.

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
      AND (
        u.role IN ('superadmin', 'admin')
        OR COALESCE(menu.has_access, FALSE)
      )
  );
$$;

REVOKE ALL ON FUNCTION public.mp_can_manage_new_orders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mp_can_manage_new_orders() TO authenticated;

-- Import batches: admins can manage every batch. Other permitted roles may
-- create and read only batches that they uploaded themselves.
DROP POLICY IF EXISTS mp_batches_all ON public.mp_import_batches;
DROP POLICY IF EXISTS mp_batches_select ON public.mp_import_batches;
DROP POLICY IF EXISTS mp_batches_insert ON public.mp_import_batches;
DROP POLICY IF EXISTS mp_batches_update ON public.mp_import_batches;
DROP POLICY IF EXISTS mp_batches_delete ON public.mp_import_batches;

CREATE POLICY mp_batches_select ON public.mp_import_batches
  FOR SELECT TO authenticated
  USING (
    public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
    OR (public.mp_can_manage_new_orders() AND uploaded_by = auth.uid())
  );

CREATE POLICY mp_batches_insert ON public.mp_import_batches
  FOR INSERT TO authenticated
  WITH CHECK (
    public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
    OR (public.mp_can_manage_new_orders() AND uploaded_by = auth.uid())
  );

CREATE POLICY mp_batches_update ON public.mp_import_batches
  FOR UPDATE TO authenticated
  USING (public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin']))
  WITH CHECK (public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin']));

CREATE POLICY mp_batches_delete ON public.mp_import_batches
  FOR DELETE TO authenticated
  USING (public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin']));

-- Orders: a role with marketplace-new may import and assign unassigned work.
-- Sales users retain access to work assigned to themselves.
DROP POLICY IF EXISTS mp_orders_select ON public.mp_orders;
DROP POLICY IF EXISTS mp_orders_insert ON public.mp_orders;
DROP POLICY IF EXISTS mp_orders_update ON public.mp_orders;
DROP POLICY IF EXISTS mp_orders_delete ON public.mp_orders;

CREATE POLICY mp_orders_select ON public.mp_orders
  FOR SELECT TO authenticated
  USING (
    public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
    OR (
      public.mp_can_manage_new_orders()
      AND (status = 'new' OR assigned_by = auth.uid())
    )
    OR (
      assigned_to = auth.uid()
      AND public.check_user_role(auth.uid(), ARRAY['sales-tr', 'sales-pump'])
    )
  );

CREATE POLICY mp_orders_insert ON public.mp_orders
  FOR INSERT TO authenticated
  WITH CHECK (
    public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
    OR (
      public.mp_can_manage_new_orders()
      AND status = 'new'
      AND assigned_to IS NULL
    )
  );

CREATE POLICY mp_orders_update ON public.mp_orders
  FOR UPDATE TO authenticated
  USING (
    public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
    OR (public.mp_can_manage_new_orders() AND status = 'new')
    OR (
      assigned_to = auth.uid()
      AND public.check_user_role(auth.uid(), ARRAY['sales-tr', 'sales-pump'])
    )
  )
  WITH CHECK (
    public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin'])
    OR (
      public.mp_can_manage_new_orders()
      AND (
        (status = 'new' AND assigned_to IS NULL)
        OR (
          status = 'assigned'
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

CREATE POLICY mp_orders_delete ON public.mp_orders
  FOR DELETE TO authenticated
  USING (public.check_user_role(auth.uid(), ARRAY['superadmin', 'admin']));

-- Items inserted during import must belong to a new order visible to the
-- importer. Existing update/delete rules remain intentionally restrictive.
DROP POLICY IF EXISTS mp_items_select ON public.mp_order_items;
DROP POLICY IF EXISTS mp_items_insert ON public.mp_order_items;

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
            AND (o.status = 'new' OR o.assigned_by = auth.uid())
          )
          OR (
            o.assigned_to = auth.uid()
            AND public.check_user_role(auth.uid(), ARRAY['sales-tr', 'sales-pump'])
          )
        )
    )
  );

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
  );

COMMIT;
