-- Read-only verification for migration 314.
-- Run after applying 314_fix_public_rls_and_fifo_function_security.sql.

SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'inv_lot_consumptions';

SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('inv_lot_consumptions', 'us_users')
ORDER BY tablename, policyname;

SELECT
  role_name,
  has_table_privilege(role_name, 'public.inv_lot_consumptions', 'SELECT') AS can_select,
  has_table_privilege(role_name, 'public.inv_lot_consumptions', 'INSERT') AS can_insert,
  has_table_privilege(role_name, 'public.inv_lot_consumptions', 'UPDATE') AS can_update,
  has_table_privilege(role_name, 'public.inv_lot_consumptions', 'DELETE') AS can_delete
FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS role_name;

SELECT
  role_name,
  has_function_privilege(
    role_name,
    'public.fn_consume_stock_fifo(uuid,numeric,uuid)',
    'EXECUTE'
  ) AS can_execute_fifo_helper,
  has_function_privilege(
    role_name,
    'public.rpc_recalc_po_landed_cost(uuid)',
    'EXECUTE'
  ) AS can_execute_recalc_rpc
FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS role_name;

SELECT
  p.oid::regprocedure AS function_name,
  p.prosecdef AS security_definer,
  p.proconfig AS function_config
FROM pg_proc AS p
JOIN pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'fn_get_current_avg_cost',
    'fn_consume_stock_fifo',
    'fn_recalc_product_landed_cost',
    'fn_update_product_landed_costs',
    'rpc_recalc_po_landed_cost'
  )
ORDER BY p.proname;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'inv_lot_consumptions'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'FAILED: RLS is not enabled on inv_lot_consumptions';
  END IF;

  IF has_table_privilege('anon', 'public.inv_lot_consumptions', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'public.inv_lot_consumptions', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'FAILED: a browser role still has direct inv_lot_consumptions privileges';
  END IF;

  IF has_table_privilege('anon', 'public.us_users', 'INSERT')
     OR has_table_privilege('authenticated', 'public.us_users', 'INSERT') THEN
    RAISE EXCEPTION 'FAILED: a browser role can still create its own us_users profile';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.fn_consume_stock_fifo(uuid,numeric,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_consume_stock_fifo(uuid,numeric,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'FAILED: a browser role can execute fn_consume_stock_fifo';
  END IF;
END;
$$;
