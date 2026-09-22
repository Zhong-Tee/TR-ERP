-- Separate inventory-adjustment duties:
--   creators:  superadmin, admin, manager, account, store
--   approvers: superadmin, admin, manager, account
--
-- Account may run the low-level stock mutation helpers only while executing
-- the guarded approval RPC. Direct calls by account remain rejected.

BEGIN;

DO $migration$
DECLARE
  v_definition text;
  v_updated text;
BEGIN
  SELECT pg_get_functiondef(
    'public.rpc_create_inventory_adjustment(text,text,text,jsonb)'::regprocedure
  ) INTO v_definition;

  v_updated := regexp_replace(
    v_definition,
    'v_role NOT IN \([^)]*\)',
    'v_role NOT IN (''superadmin'', ''admin'', ''manager'', ''account'', ''store'')',
    'g'
  );

  IF v_updated NOT LIKE '%v_role NOT IN (''superadmin'', ''admin'', ''manager'', ''account'', ''store'')%' THEN
    RAISE EXCEPTION 'Inventory-adjustment creator role guard could not be verified';
  END IF;
  EXECUTE v_updated;

  SELECT pg_get_functiondef('public.bulk_adjust_stock(jsonb)'::regprocedure)
  INTO v_definition;

  v_updated := regexp_replace(
    v_definition,
    'IF v_role IS NULL OR v_role NOT IN \([^)]*\) THEN',
    'IF v_role IS NULL OR (
    v_role NOT IN (''superadmin'', ''admin'', ''admin-tr'', ''manager'', ''store'')
    AND NOT (
      v_role = ''account''
      AND current_setting(''app.inventory_adjustment_approval'', true) = ''on''
    )
  ) THEN',
    'g'
  );

  IF v_updated NOT LIKE '%app.inventory_adjustment_approval%' THEN
    RAISE EXCEPTION 'bulk_adjust_stock approval context could not be verified';
  END IF;
  EXECUTE v_updated;

  SELECT pg_get_functiondef('public.bulk_update_safety_stock(jsonb)'::regprocedure)
  INTO v_definition;

  v_updated := regexp_replace(
    v_definition,
    'IF v_role IS NULL OR v_role NOT IN \([^)]*\) THEN',
    'IF v_role IS NULL OR (
    v_role NOT IN (''superadmin'', ''admin'', ''admin-tr'', ''manager'', ''store'')
    AND NOT (
      v_role = ''account''
      AND current_setting(''app.inventory_adjustment_approval'', true) = ''on''
    )
  ) THEN',
    'g'
  );

  IF v_updated NOT LIKE '%app.inventory_adjustment_approval%' THEN
    RAISE EXCEPTION 'bulk_update_safety_stock approval context could not be verified';
  END IF;
  EXECUTE v_updated;

  SELECT pg_get_functiondef('public.rpc_approve_inventory_adjustment(uuid)'::regprocedure)
  INTO v_definition;

  v_updated := regexp_replace(
    v_definition,
    'v_role NOT IN \([^)]*\)',
    'v_role NOT IN (''superadmin'', ''admin'', ''manager'', ''account'')',
    'g'
  );

  IF v_updated NOT LIKE '%v_role NOT IN (''superadmin'', ''admin'', ''manager'', ''account'')%' THEN
    RAISE EXCEPTION 'Inventory-adjustment approval role guard could not be verified';
  END IF;

  IF v_updated NOT LIKE '%app.inventory_adjustment_approval%' THEN
    v_definition := v_updated;
    v_updated := replace(
      v_definition,
      '  SELECT * INTO v_adjustment FROM public.inv_adjustments',
      '  -- Transaction-local capability consumed by the low-level stock helpers.
  -- It is set only after this RPC has authenticated an allowed approver.
  PERFORM set_config(''app.inventory_adjustment_approval'', ''on'', true);

  SELECT * INTO v_adjustment FROM public.inv_adjustments'
    );

    IF v_updated = v_definition THEN
      RAISE EXCEPTION 'Inventory-adjustment approval body could not be updated';
    END IF;
  END IF;
  EXECUTE v_updated;
END;
$migration$;

REVOKE ALL ON FUNCTION public.rpc_approve_inventory_adjustment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_approve_inventory_adjustment(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.rpc_approve_inventory_adjustment(uuid) IS
  'Approves inventory adjustments. Allowed roles: superadmin, admin, manager and account; store is creator-only.';

COMMENT ON FUNCTION public.rpc_create_inventory_adjustment(text, text, text, jsonb) IS
  'Creates inventory adjustments. Allowed roles: superadmin, admin, manager, account and store.';

COMMIT;

NOTIFY pgrst, 'reload schema';
