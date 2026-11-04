-- =============================================================================
-- Migration 304: PR/PO/GR and sample workflow legacy-role cleanup (scoped)
--   - PR/PO/GR, samples, sellers, GR images: remove admin-tr.
--   - PO editing RPCs: replace admin-tr with admin.
-- Missing optional routines/policies are skipped.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  target record;
  routine_oid oid;
  definition text;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('public.rpc_update_sample_test(uuid,text,uuid,text,text,text,jsonb)', 'remove'),
      ('public.rpc_convert_sample_to_product(uuid,uuid,text,text,text,text,text,text,uuid)', 'remove'),
      ('public.rpc_create_pr_seller(text,text)', 'remove'),
      ('public.rpc_update_po_expected_arrival_date(uuid,date,uuid)', 'replace_admin'),
      ('public.rpc_update_po(uuid,text,date,jsonb)', 'replace_admin')
    ) AS targets(signature, action)
  LOOP
    routine_oid := to_regprocedure(target.signature);
    IF routine_oid IS NULL THEN
      CONTINUE;
    END IF;

    definition := pg_get_functiondef(routine_oid);

    IF target.action = 'replace_admin' THEN
      -- Add current admin only where it is missing, then remove the legacy name.
      IF definition NOT LIKE '%''admin''%' THEN
        definition := replace(definition, 'admin-tr', 'admin');
      ELSE
        definition := regexp_replace(
          definition,
          ',[[:space:]]*''admin-tr''',
          '',
          'g'
        );
      END IF;
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
      ('inv_pr', 'Purchase roles can manage PR'),
      ('inv_pr_items', 'Purchase roles can manage PR items'),
      ('inv_po', 'Purchase roles can manage PO'),
      ('inv_po_items', 'Purchase roles can manage PO items'),
      ('inv_gr', 'Purchase roles can manage GR'),
      ('inv_gr_items', 'Purchase roles can manage GR items'),
      ('pr_sellers', 'pr_sellers write'),
      ('inv_gr_item_images', 'Purchase roles can manage GR item images')
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
