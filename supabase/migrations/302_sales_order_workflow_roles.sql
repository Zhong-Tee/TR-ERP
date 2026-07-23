-- =============================================================================
-- Migration 302: scoped sales-role cleanup for bill edit and amendment workflow
-- Decisions:
--   1) Current chat RPCs (migration 219) already use sales-pump only.
--   2) Production name-line edits: admin-tr/admin-pump are removed, not replaced.
--   3) sales-tr/sales-pump may create/read requests for their own orders only.
--      Approval remains account/admin/superadmin.
-- =============================================================================

BEGIN;

-- Shared ownership check. Match the same username/email forms used by Orders.
CREATE OR REPLACE FUNCTION public.sales_owns_order(p_order_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.or_orders o
    JOIN public.us_users u ON u.id = auth.uid()
    WHERE o.id = p_order_id
      AND u.role IN ('sales-tr', 'sales-pump')
      AND trim(COALESCE(o.admin_user, '')) <> ''
      AND lower(trim(COALESCE(o.admin_user, ''))) IN (
        lower(trim(COALESCE(u.username, ''))),
        lower(trim(COALESCE(u.email, ''))),
        lower(trim(COALESCE(auth.jwt() ->> 'email', '')))
      )
  );
$$;

REVOKE ALL ON FUNCTION public.sales_owns_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sales_owns_order(uuid) TO authenticated;

-- Remove legacy sales roles from the narrowly scoped production name-line RPC.
-- Preserve the rest of the latest function body exactly as deployed.
DO $$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.rpc_update_order_item_name_lines(uuid,jsonb,text)'::regprocedure
  ) INTO function_definition;

  IF function_definition IS NULL THEN
    RAISE EXCEPTION 'rpc_update_order_item_name_lines(uuid,jsonb,text) not found';
  END IF;

  function_definition := regexp_replace(
    function_definition,
    ',[[:space:]]*''admin-tr''',
    '',
    'g'
  );
  function_definition := regexp_replace(
    function_definition,
    ',[[:space:]]*''admin-pump''',
    '',
    'g'
  );

  IF function_definition LIKE '%admin-tr%'
     OR function_definition LIKE '%admin-pump%' THEN
    RAISE EXCEPTION 'Unable to safely remove legacy roles from rpc_update_order_item_name_lines';
  END IF;

  EXECUTE function_definition;
END;
$$;

-- Amendment requests: privileged roles see all; sales see/create only their own.
DROP POLICY IF EXISTS "or_order_amendments_select" ON public.or_order_amendments;
CREATE POLICY "or_order_amendments_select"
  ON public.or_order_amendments FOR SELECT TO authenticated
  USING (
    public.sales_owns_order(order_id)
    OR EXISTS (
      SELECT 1 FROM public.us_users u
      WHERE u.id = auth.uid()
        AND u.role IN ('superadmin', 'admin', 'account', 'admin_qc', 'manager')
    )
  );

DROP POLICY IF EXISTS "or_order_amendments_insert" ON public.or_order_amendments;
CREATE POLICY "or_order_amendments_insert"
  ON public.or_order_amendments FOR INSERT TO authenticated
  WITH CHECK (
    (public.sales_owns_order(order_id) AND requested_by = auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.us_users u
      WHERE u.id = auth.uid()
        AND u.role IN ('superadmin', 'admin', 'account', 'admin_qc')
    )
  );

DROP POLICY IF EXISTS "or_order_amendments_update" ON public.or_order_amendments;
CREATE POLICY "or_order_amendments_update"
  ON public.or_order_amendments FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid()
      AND u.role IN ('superadmin', 'admin', 'account')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.us_users u
    WHERE u.id = auth.uid()
      AND u.role IN ('superadmin', 'admin', 'account')
  ));

-- SECURITY DEFINER submission RPCs bypass table RLS. Enforce the same rule in
-- triggers so a sales user cannot submit a request for another salesperson's bill.
CREATE OR REPLACE FUNCTION public.enforce_sales_request_ownership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_role text;
BEGIN
  SELECT role INTO current_role FROM public.us_users WHERE id = auth.uid();

  IF current_role IN ('sales-tr', 'sales-pump') THEN
    IF NOT public.sales_owns_order(NEW.order_id) THEN
      RAISE EXCEPTION 'Sales can create requests only for their own orders';
    END IF;

    IF TG_TABLE_NAME = 'or_order_amendments' AND NEW.requested_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'requested_by must match the signed-in sales user';
    END IF;

  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sales_amendment_ownership ON public.or_order_amendments;
CREATE TRIGGER trg_sales_amendment_ownership
  BEFORE INSERT ON public.or_order_amendments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_sales_request_ownership();

COMMIT;
