-- =============================================================================
-- Migration 303: warehouse/stock legacy-role cleanup (scoped)
--   - Stock adjustment and WMS: remove admin-tr; do not grant sales-tr.
--   - Product import: replace admin-tr with admin.
-- Only named active routines/policies are touched. Missing optional objects skip.
-- =============================================================================

BEGIN;

-- Update only the latest active definitions of explicitly listed RPCs.
DO $$
DECLARE
  target record;
  routine_oid oid;
  definition text;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('public.bulk_adjust_stock(jsonb)', 'remove'),
      ('public.bulk_update_safety_stock(jsonb)', 'remove'),
      ('public.rpc_plan_release_orders_to_workqueue(text,uuid[])', 'remove'),
      ('public.rpc_plan_release_orders_to_workqueue_v2(uuid,uuid[])', 'remove'),
      ('public.rpc_bulk_import_products_with_stock(jsonb)', 'replace_admin')
    ) AS targets(signature, action)
  LOOP
    routine_oid := to_regprocedure(target.signature);
    IF routine_oid IS NULL THEN
      CONTINUE;
    END IF;

    definition := pg_get_functiondef(routine_oid);

    IF target.action = 'replace_admin' THEN
      definition := replace(definition, 'admin-tr', 'admin');
    ELSE
      definition := regexp_replace(
        definition,
        ',[[:space:]]*''admin-tr''',
        '',
        'g'
      );
    END IF;

    IF definition LIKE '%admin-tr%' THEN
      RAISE EXCEPTION 'Unable to safely clean legacy role from %', target.signature;
    END IF;

    EXECUTE definition;
  END LOOP;
END;
$$;

-- Remove admin-tr from the selected active RLS policies while preserving every
-- other role and the latest policy expression. Catalog lookup also makes this
-- safe on installations where an optional WMS table is absent.
DO $$
DECLARE
  policy_row record;
  role_list text;
  using_expression text;
  check_expression text;
  alter_sql text;
BEGIN
  FOR policy_row IN
    SELECT p.schemaname, p.tablename, p.policyname, p.cmd,
           p.roles, p.qual, p.with_check
    FROM pg_policies p
    JOIN (VALUES
      ('inv_stock_balances', 'Admins can manage stock balances'),
      ('inv_stock_movements', 'Admins can manage stock movements'),
      ('wms_borrow_requisitions', 'Production and admins can create borrow requisitions'),
      ('wms_borrow_requisitions', 'Admins can manage borrow requisitions'),
      ('wms_borrow_requisitions', 'Admins can delete borrow requisitions'),
      ('wms_borrow_requisition_items', 'Production and admins can create borrow requisition items'),
      ('wms_borrow_requisition_items', 'Admins can manage borrow requisition items'),
      ('inv_returns', 'Production can create returns'),
      ('inv_return_items', 'Production can create return items')
    ) AS targets(tablename, policyname)
      ON targets.tablename = p.tablename
     AND targets.policyname = p.policyname
    WHERE p.schemaname = 'public'
      AND (
        COALESCE(p.qual, '') LIKE '%admin-tr%'
        OR COALESCE(p.with_check, '') LIKE '%admin-tr%'
      )
  LOOP
    SELECT string_agg(quote_ident(role_name), ', ')
    INTO role_list
    FROM unnest(policy_row.roles) AS role_name;

    using_expression := regexp_replace(
      policy_row.qual,
      ',[[:space:]]*''admin-tr''::text',
      '',
      'g'
    );
    check_expression := regexp_replace(
      policy_row.with_check,
      ',[[:space:]]*''admin-tr''::text',
      '',
      'g'
    );

    IF COALESCE(using_expression, '') LIKE '%admin-tr%'
       OR COALESCE(check_expression, '') LIKE '%admin-tr%' THEN
      RAISE EXCEPTION 'Unable to safely clean policy %.%/%',
        policy_row.schemaname, policy_row.tablename, policy_row.policyname;
    END IF;

    alter_sql := format(
      'ALTER POLICY %I ON %I.%I TO %s',
      policy_row.policyname,
      policy_row.schemaname,
      policy_row.tablename,
      COALESCE(role_list, 'PUBLIC')
    );

    IF policy_row.cmd IN ('SELECT', 'UPDATE', 'DELETE', 'ALL')
       AND using_expression IS NOT NULL THEN
      alter_sql := alter_sql || format(' USING (%s)', using_expression);
    END IF;

    IF policy_row.cmd IN ('INSERT', 'UPDATE', 'ALL')
       AND check_expression IS NOT NULL THEN
      alter_sql := alter_sql || format(' WITH CHECK (%s)', check_expression);
    END IF;

    EXECUTE alter_sql;
  END LOOP;
END;
$$;

COMMIT;
